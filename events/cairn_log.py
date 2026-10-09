#!/usr/bin/env python3
"""Cairn append-only event log. stdlib only.  python3 cairn_log.py --help

Backends (first match wins):
  --db FILE / --demo        SQLite file (explicit)
  CLICKHOUSE_URL            ClickHouse over HTTP(S); CLICKHOUSE_USER / CLICKHOUSE_PASSWORD from env only
  127.0.0.1:8123 answers    local Docker ClickHouse (only if YOU started it)
  else                      SQLite events/cairn.db
Set CAIRN_BACKEND=sqlite to skip ClickHouse entirely.
Append-only: this program only issues INSERT and SELECT (SQLite also gets triggers that reject UPDATE/DELETE).
"""
import argparse, json, os, re, sqlite3, sys, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.path.join(HERE, "cairn.db")
DEMO_DB = os.path.join(HERE, "demo.db")
COLS = ["ts", "kind", "card_id", "repo", "file", "line", "actor", "tool", "detail", "verdict"]
KINDS = {"finding", "cousin_candidate", "human_confirm", "agent_write", "agent_ignored_finding",
         "pr_gate", "device_approval", "reintroduced"}
CARD_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
VERDICT_RE = re.compile(r"^[a-z0-9_.-]{0,32}$")
MAX_LEN = {"repo": 200, "file": 500, "actor": 100, "tool": 100, "detail": 2000}
MAX_LINE_BYTES = 16384
MAX_ROWS = 1000
CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

SQLITE_DDL = """
CREATE TABLE IF NOT EXISTS cairn_events (
  ts TEXT NOT NULL, kind TEXT NOT NULL, card_id TEXT NOT NULL, repo TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL DEFAULT '', line INTEGER NOT NULL DEFAULT 0, actor TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS ix_card_ts ON cairn_events(card_id, ts);
CREATE TRIGGER IF NOT EXISTS no_update BEFORE UPDATE ON cairn_events BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER IF NOT EXISTS no_delete BEFORE DELETE ON cairn_events BEGIN SELECT RAISE(ABORT,'append-only'); END;
"""


class ValidationError(Exception):
    pass


def now_utc():
    return datetime.now(timezone.utc)


def fmt_ts(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.") + f"{dt.microsecond // 1000:03d}"


def parse_ts(v):
    if not isinstance(v, str) or len(v) > 40:
        raise ValidationError("ts must be an ISO-8601 string")
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        raise ValidationError("ts is not valid ISO-8601")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return fmt_ts(dt)


def validate(obj):
    """Return a clean row dict or raise ValidationError. Unknown fields are rejected."""
    if not isinstance(obj, dict):
        raise ValidationError("event must be a JSON object")
    extra = set(obj) - set(COLS)
    if extra:
        raise ValidationError(f"unknown field(s): {sorted(extra)[:5]}")
    row = {}
    if obj.get("kind") not in KINDS:
        raise ValidationError(f"kind must be one of {sorted(KINDS)}")
    row["kind"] = obj["kind"]
    c = obj.get("card_id")
    if not isinstance(c, str) or not CARD_RE.match(c):
        raise ValidationError("card_id must match ^[a-z0-9][a-z0-9_.-]{0,63}$")
    row["card_id"] = c
    for f, mx in MAX_LEN.items():
        v = obj.get(f, "")
        if not isinstance(v, str):
            raise ValidationError(f"{f} must be a string")
        if len(v) > mx:
            raise ValidationError(f"{f} longer than {mx} chars")
        if CTRL.search(v):
            raise ValidationError(f"{f} contains control characters")
        row[f] = v
    ln = obj.get("line", 0)
    if isinstance(ln, bool) or not isinstance(ln, int) or not (0 <= ln <= 10_000_000):
        raise ValidationError("line must be an integer 0..10000000")
    row["line"] = ln
    v = obj.get("verdict", "")
    if not isinstance(v, str) or not VERDICT_RE.match(v):
        raise ValidationError("verdict must match ^[a-z0-9_.-]{0,32}$")
    row["verdict"] = v
    row["ts"] = parse_ts(obj["ts"]) if "ts" in obj else fmt_ts(now_utc())
    return {k: row[k] for k in COLS}


def parse_lines(texts):
    rows = []
    for i, t in enumerate(texts, 1):
        t = t.strip()
        if not t:
            continue
        if len(t.encode("utf-8")) > MAX_LINE_BYTES:
            raise ValidationError(f"input {i}: longer than {MAX_LINE_BYTES} bytes")
        try:
            obj = json.loads(t)
        except json.JSONDecodeError:
            raise ValidationError(f"input {i}: not valid JSON")
        try:
            rows.append(validate(obj))
        except ValidationError as e:
            raise ValidationError(f"input {i}: {e}")
        if len(rows) > MAX_ROWS:
            raise ValidationError(f"more than {MAX_ROWS} events in one call")
    return rows


# ---------------- backends ----------------
class SQLiteBackend:
    def __init__(self, path):
        self.name = f"sqlite:{path}"
        self.con = sqlite3.connect(path)
        self.con.executescript(SQLITE_DDL)

    def insert(self, rows):
        with self.con:
            self.con.executemany(
                f"INSERT INTO cairn_events ({','.join(COLS)}) VALUES ({','.join('?' * len(COLS))})",
                [tuple(r[c] for c in COLS) for r in rows])

    def select(self, sql):
        cur = self.con.execute(sql)
        names = [d[0] for d in cur.description]
        return [dict(zip(names, r)) for r in cur.fetchall()]


class ClickHouseBackend:
    def __init__(self, url, label):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise SystemExit("CLICKHOUSE_URL must be http(s)://host:port")
        if u.username or u.password:
            raise SystemExit("Put credentials in CLICKHOUSE_USER/CLICKHOUSE_PASSWORD, not in the URL")
        if u.scheme == "http" and u.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise SystemExit("Refusing plain http to a non-local host; use https")
        self.base = f"{u.scheme}://{u.netloc}/"
        self.name = f"clickhouse:{u.scheme}://{u.hostname}:{u.port or ''}"
        self.headers = {}
        if os.environ.get("CLICKHOUSE_USER"):
            self.headers["X-ClickHouse-User"] = os.environ["CLICKHOUSE_USER"]
        if os.environ.get("CLICKHOUSE_PASSWORD"):
            self.headers["X-ClickHouse-Key"] = os.environ["CLICKHOUSE_PASSWORD"]
        with open(os.path.join(HERE, "schema.sql")) as f:
            self._post("", f.read().encode())

    def _post(self, query, body):
        url = self.base + ("?" + urllib.parse.urlencode({"query": query}) if query else "")
        req = urllib.request.Request(url, data=body, headers=self.headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode()
        except urllib.error.HTTPError as e:  # never echo headers/URL
            raise SystemExit(f"ClickHouse HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")
        except Exception as e:
            raise SystemExit(f"ClickHouse unreachable ({type(e).__name__})")

    def insert(self, rows):
        body = "\n".join(json.dumps(r) for r in rows).encode()
        self._post("INSERT INTO cairn_events FORMAT JSONEachRow", body)

    def select(self, sql):
        out = self._post("", (sql.rstrip().rstrip(";") + " FORMAT JSONEachRow").encode())
        return [json.loads(l) for l in out.splitlines() if l.strip()]


def local_clickhouse_up():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8123/ping", timeout=0.3) as r:
            return r.read().strip() == b"Ok."
    except Exception:
        return False


def get_backend(args):
    if getattr(args, "demo", False):
        return SQLiteBackend(DEMO_DB)
    if getattr(args, "db", None):
        return SQLiteBackend(args.db)
    if os.environ.get("CAIRN_BACKEND") != "sqlite":
        if os.environ.get("CLICKHOUSE_URL"):
            return ClickHouseBackend(os.environ["CLICKHOUSE_URL"], "remote")
        if local_clickhouse_up():
            return ClickHouseBackend("http://127.0.0.1:8123", "local")
    return SQLiteBackend(DEFAULT_DB)


# ---------------- queries ----------------
def load_queries():
    q, name = {}, None
    with open(os.path.join(HERE, "queries.sql")) as f:
        for line in f:
            m = re.match(r"-- name: (\w+)", line)
            if m:
                name = m.group(1)
                q[name] = []
            elif name and not line.startswith("--"):
                q[name].append(line)
    return {k: "".join(v).strip() for k, v in q.items()}


def parse_window(s):
    m = re.fullmatch(r"(\d{1,5})([smhd])", s)
    if not m:
        raise SystemExit("--window must look like 90s, 10m, 2h, 1d")
    return timedelta(**{{"s": "seconds", "m": "minutes", "h": "hours", "d": "days"}[m.group(2)]: int(m.group(1))})


def P(t=""):
    print(t)


def show_sql(sql):
    P("SQL used:")
    for l in sql.splitlines():
        P("    " + l)


def tparse(s):
    return datetime.strptime(str(s)[:23].ljust(23, "0"), "%Y-%m-%d %H:%M:%S.%f")


def table(rows, cols):
    if not rows:
        return
    w = [max(len(c), *(len(str(r[c])) for r in rows)) for c in cols]
    w = [min(x, 60) for x in w]
    P("    " + "  ".join(c.ljust(x) for c, x in zip(cols, w)))
    for r in rows:
        P("    " + "  ".join(str(r[c])[:x].ljust(x) for c, x in zip(cols, w)))


def cmd_incident(a, be):
    qs = load_queries()
    win = parse_window(a.window)
    cutoff = fmt_ts(now_utc() - win)
    gq = qs["incident_groups"].replace("{cutoff}", cutoff)
    eq = qs["incident_evidence"].replace("{cutoff}", cutoff)
    groups, ev = be.select(gq), be.select(eq)
    P(f"Backend: {be.name}   window: last {a.window} (since {cutoff} UTC)")
    if not groups:
        P("No events in this window, so there is no incident to report.")
        show_sql(gq)
        return
    for g in groups:
        n, files, repos = int(g["n"]), int(g["files"]), int(g["repos"])
        rows = [r for r in ev if r["card_id"] == g["card_id"]]
        kinds = {r["kind"] for r in rows}
        span = (tparse(g["last_ts"]) - tparse(g["first_ts"])).total_seconds()
        chain = []
        if "finding" in kinds: chain.append("a scanner flagged it")
        if "agent_write" in kinds: chain.append("an agent wrote code")
        if "agent_ignored_finding" in kinds: chain.append("the agent ignored the warning")
        if "reintroduced" in kinds: chain.append("the bug came back after a fix")
        one = n >= 2 and (files >= 2 or repos >= 2 or len(chain) >= 2)
        P()
        P(f"== card {g['card_id']}: {n} events, {files} file(s), {repos} repo(s), over {span:.0f}s")
        if one:
            why = f"same behavior card, {n} events inside {a.window}"
            if files >= 2: why += f", touching {files} different files"
            if repos >= 2: why += f" across {repos} repos"
            P(f"   VERDICT: YES, treat as ONE incident ({why}).")
            if chain: P("   Story: " + "; ".join(chain) + ".")
        else:
            P(f"   VERDICT: NO, looks isolated (only {n} event, one file, no chain).")
        P("   Evidence rows:")
        table(rows, ["ts", "kind", "repo", "file", "line", "actor", "verdict"])
    P()
    show_sql(gq)
    show_sql(eq)


def cmd_spread(a, be):
    if not CARD_RE.match(a.card):
        raise SystemExit("invalid card id")
    sq = load_queries()["spread"].replace("{card}", a.card)
    rows = be.select(sq)
    P(f"Backend: {be.name}   card: {a.card}")
    if not rows:
        P("No events for this card.")
        show_sql(sq)
        return
    recent = parse_window(a.recent)
    latest = max(tparse(r["last_seen"]) for r in rows)
    ref = max(latest, now_utc().replace(tzinfo=None)) if a.live else latest
    P(f"{len(rows)} file(s) in {len({r['repo'] for r in rows})} repo(s). First-seen order (the spread over time):")
    table(rows, ["first_seen", "repo", "file", "n"])
    new = [r for r in rows if ref - tparse(r["first_seen"]) <= recent]
    first = min(tparse(r["first_seen"]) for r in rows)
    reach_to = max(tparse(r["first_seen"]) for r in rows)
    P(f"Spread span: {(reach_to - first).total_seconds():.0f}s from first to newest file.")
    if new and len(new) < len(rows):
        P(f"VERDICT: STILL SPREADING, {len(new)} new file(s) first seen in the last {a.recent} of the data.")
    elif new:
        P("VERDICT: just started (every file is new in the last " + a.recent + ").")
    else:
        P(f"VERDICT: contained for now, no new file in the last {a.recent} of the data.")
    show_sql(sq)


def cmd_ignored(a, be):
    sq = load_queries()["ignored"]
    rows = be.select(sq)
    P(f"Backend: {be.name}")
    P(f"{len(rows)} finding(s) the agent saw and ignored:")
    table(rows, ["ts", "card_id", "repo", "file", "line", "actor", "detail"])
    show_sql(sq)


def cmd_append(a, be):
    texts = list(a.json)
    if not texts:
        if sys.stdin.isatty():
            raise SystemExit("give JSON args or pipe JSON lines on stdin")
        texts = sys.stdin.read(MAX_ROWS * MAX_LINE_BYTES + 1).splitlines()
    try:
        rows = parse_lines(texts)
    except ValidationError as e:
        print(f"REJECTED (nothing written): {e}", file=sys.stderr)
        sys.exit(2)
    if rows:
        be.insert(rows)
    P(f"appended {len(rows)} event(s) to {be.name}")


def cmd_demo_seed(a, _be):
    if os.path.exists(DEMO_DB):
        if not a.fresh:
            raise SystemExit(f"{DEMO_DB} exists; pass --fresh to recreate the demo file (demo db only)")
        os.unlink(DEMO_DB)
    be = SQLiteBackend(DEMO_DB)
    be.con.execute("CREATE TABLE demo_label (note TEXT)")
    be.con.execute("INSERT INTO demo_label VALUES ('DEMO DATA, synthetic, generated by cairn_log.py demo-seed. Not real incidents.')")
    be.con.commit()
    t0 = now_utc() - timedelta(minutes=9)
    U, Z = "unvalidated-network-input", "unpinned-dependency"
    spec = [  # (minute offset, kind, card, repo, file, line, actor, tool, verdict, detail)
        (0.0, "finding", U, "esptember", "day22/hub/server.c", 88, "semgrep", "semgrep", "open", "strcpy of request body into 64-byte buffer"),
        (0.5, "agent_write", U, "esptember", "day22/hub/routes.c", 41, "coding-agent", "claude-code", "", "agent copied the same pattern into a new route"),
        (0.6, "agent_ignored_finding", U, "esptember", "day22/hub/routes.c", 41, "coding-agent", "semgrep-guardian", "ignored", "guardian warned on write; agent continued without fixing"),
        (2.0, "agent_write", U, "esptember", "day23/firmware/net.c", 17, "coding-agent", "claude-code", "", "same unchecked length used in firmware packet parser"),
        (2.1, "agent_ignored_finding", U, "esptember", "day23/firmware/net.c", 17, "coding-agent", "semgrep-guardian", "ignored", "warning dismissed"),
        (3.5, "cousin_candidate", U, "esptember", "day27/ota.c", 203, "cairn", "card-matcher", "candidate", "card match score 0.91"),
        (4.0, "human_confirm", U, "esptember", "day27/ota.c", 203, "pavan", "terminal", "confirmed", "human confirmed cousin"),
        (5.5, "agent_write", U, "stopwatch", "src/wifi_cmd.c", 66, "coding-agent", "claude-code", "", "pattern appeared in a second repo"),
        (6.0, "finding", U, "stopwatch", "src/wifi_cmd.c", 66, "semgrep", "semgrep", "open", "unchecked length from network"),
        (7.0, "pr_gate", U, "esptember", "", 0, "cairn", "pr-gate", "block", "PR blocked: card still open on 4 files"),
        (7.5, "device_approval", U, "esptember", "", 0, "pavan", "stopwatch", "approved", "approved fix PR on device"),
        (8.5, "reintroduced", U, "esptember", "day22/hub/routes.c", 41, "coding-agent", "claude-code", "regressed", "pattern returned after fix"),
        # unrelated, older, isolated
        (1.0, "finding", Z, "esptember", "day31/requirements.txt", 3, "semgrep", "semgrep", "open", "unpinned dependency"),
    ]
    rows = []
    for m, k, c, repo, f, ln, actor, tool, ver, det in spec:
        rows.append(validate({"ts": (t0 + timedelta(minutes=m)).isoformat(), "kind": k, "card_id": c, "repo": repo,
                              "file": f, "line": ln, "actor": actor, "tool": tool, "verdict": ver,
                              "detail": "DEMO: " + det}))
    be.insert(rows)
    P(f"DEMO seed: wrote {len(rows)} synthetic events to {DEMO_DB} (labelled DEMO; never the real log)")


def main():
    p = argparse.ArgumentParser(description="Cairn append-only event log")
    p.add_argument("--db", help="use this SQLite file")
    p.add_argument("--demo", action="store_true", help="use events/demo.db (demo data)")
    s = p.add_subparsers(dest="cmd", required=True)
    x = s.add_parser("append"); x.add_argument("json", nargs="*", help="JSON events; else JSON lines on stdin"); x.set_defaults(f=cmd_append)
    x = s.add_parser("incident"); x.add_argument("--window", default="10m"); x.set_defaults(f=cmd_incident)
    x = s.add_parser("spread"); x.add_argument("--card", required=True); x.add_argument("--recent", default="3m")
    x.add_argument("--live", action="store_true", help="measure 'recent' against now instead of the last event"); x.set_defaults(f=cmd_spread)
    x = s.add_parser("ignored"); x.set_defaults(f=cmd_ignored)
    x = s.add_parser("demo-seed"); x.add_argument("--fresh", action="store_true"); x.set_defaults(f=cmd_demo_seed)
    a = p.parse_args()
    be = None if a.cmd == "demo-seed" else get_backend(a)
    a.f(a, be)


if __name__ == "__main__":
    main()
