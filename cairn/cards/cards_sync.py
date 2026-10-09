#!/usr/bin/env python3
"""Sync cards/*.md into the append-only cairn_cards table. stdlib only.

  source cairn/env-clickhouse.sh && python3 cairn/cards/cards_sync.py sync
  python3 cairn/cards/cards_sync.py --sqlite events/cards.db sync
  ... list | show <card_id>

Backend: CLICKHOUSE_URL (+ CLICKHOUSE_USER/CLICKHOUSE_PASSWORD from env, sent as headers) unless --sqlite.
Only INSERT and SELECT are issued. A card gets a new version row only if its file sha256 differs
from the latest stored sha. Rows are sent as JSONEachRow in the body; nothing is interpolated into SQL
except a card_id that has first been checked against a strict regex.
"""
import argparse, glob, hashlib, json, os, re, sqlite3, sys, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
CARDS_DIR = os.path.join(ROOT, "cards")
SCHEMA = os.path.join(ROOT, "events", "cards_schema.sql")
COLS = ["card_id", "version", "created_at", "status", "class", "severity", "seed", "behavior", "why",
        "recognize", "known_copies", "safe_pattern", "verification", "source_sha256", "raw_markdown"]
SECTIONS = {"Behavior": "behavior", "Why it matters": "why", "How to recognize it": "recognize",
            "Known copies": "known_copies", "Safe pattern": "safe_pattern", "Verification": "verification"}
CARD_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
STATUSES = {"draft", "confirmed", "retired"}
MAXLEN = {"class": 64, "severity": 100, "seed": 500, "behavior": 20000, "why": 20000, "recognize": 20000,
          "known_copies": 40000, "safe_pattern": 20000, "verification": 20000, "raw_markdown": 200000}
CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")

SQLITE_DDL = """
CREATE TABLE IF NOT EXISTS cairn_cards (
  card_id TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL,
  class TEXT NOT NULL, severity TEXT NOT NULL, seed TEXT NOT NULL, behavior TEXT NOT NULL, why TEXT NOT NULL,
  recognize TEXT NOT NULL, known_copies TEXT NOT NULL, safe_pattern TEXT NOT NULL, verification TEXT NOT NULL,
  source_sha256 TEXT NOT NULL, raw_markdown TEXT NOT NULL, PRIMARY KEY (card_id, version));
CREATE TRIGGER IF NOT EXISTS cards_no_update BEFORE UPDATE ON cairn_cards BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER IF NOT EXISTS cards_no_delete BEFORE DELETE ON cairn_cards BEGIN SELECT RAISE(ABORT,'append-only'); END;
"""


class ValidationError(Exception):
    pass


def parse_card(path):
    raw_bytes = open(path, "rb").read()
    try:
        text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise ValidationError("not valid UTF-8")
    sha = hashlib.sha256(raw_bytes).hexdigest()
    m = re.match(r"\A---\n(.*?)\n---\n(.*)\Z", text, re.S)
    if not m:
        raise ValidationError("missing front matter")
    fm = {}
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        if sep:
            fm[k.strip()] = v.strip()
    body = m.group(2)
    secs, cur = {}, None
    for line in body.splitlines():
        h = re.match(r"^## (.+?)\s*$", line)
        if h:
            cur = SECTIONS.get(h.group(1))
            if cur:
                secs[cur] = []
        elif cur:
            secs[cur].append(line)
    row = {"card_id": fm.get("id", ""), "status": fm.get("status", ""), "class": fm.get("class", ""),
           "severity": fm.get("severity", ""), "seed": fm.get("seed", ""), "source_sha256": sha,
           "raw_markdown": text}
    for name in SECTIONS.values():
        if name not in secs:
            raise ValidationError(f"missing section for {name}")
        row[name] = "\n".join(secs[name]).strip()
    if row["card_id"] != os.path.splitext(os.path.basename(path))[0]:
        raise ValidationError("front matter id does not match file name")
    return validate(row)


def validate(row):
    c = row["card_id"]
    if not isinstance(c, str) or not CARD_RE.match(c):
        raise ValidationError("card_id must match ^[a-z0-9][a-z0-9_.-]{0,63}$")
    if row["status"] not in STATUSES:
        raise ValidationError(f"status must be one of {sorted(STATUSES)}")
    if not SHA_RE.match(row["source_sha256"]):
        raise ValidationError("bad sha256")
    for f, mx in MAXLEN.items():
        v = row[f]
        if not isinstance(v, str):
            raise ValidationError(f"{f} must be a string")
        if len(v) > mx:
            raise ValidationError(f"{f} longer than {mx} chars")
        if f not in ("raw_markdown", "behavior", "why", "recognize", "known_copies", "safe_pattern",
                     "verification") and CTRL.search(v):
            raise ValidationError(f"{f} contains control characters")
        if f in ("class", "severity", "seed", "behavior", "why", "recognize", "safe_pattern",
                 "verification") and not v:
            raise ValidationError(f"{f} is empty")
    return row


# ---------------- backends ----------------
class SQLiteBackend:
    def __init__(self, path):
        self.name = f"sqlite:{path}"
        self.con = sqlite3.connect(path)
        self.con.executescript(SQLITE_DDL)

    def latest(self, card_id):
        r = self.con.execute("SELECT version, source_sha256 FROM cairn_cards WHERE card_id=? ORDER BY version DESC LIMIT 1",
                             (card_id,)).fetchone()
        return (r[0], r[1]) if r else (0, None)

    def insert(self, row):
        with self.con:
            self.con.execute(f"INSERT INTO cairn_cards ({','.join(COLS)}) VALUES ({','.join('?' * len(COLS))})",
                             tuple(row[c] for c in COLS))

    def select_latest(self, card_id=None):
        sql = ("SELECT * FROM cairn_cards c WHERE version=(SELECT MAX(version) FROM cairn_cards WHERE card_id=c.card_id)"
               + (" AND card_id=?" if card_id else "") + " ORDER BY card_id")
        cur = self.con.execute(sql, (card_id,) if card_id else ())
        names = [d[0] for d in cur.description]
        return [dict(zip(names, r)) for r in cur.fetchall()]


class ClickHouseBackend:
    def __init__(self, url):
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
        with open(SCHEMA) as f:
            self._post("", f.read().encode())  # CREATE TABLE IF NOT EXISTS

    def _post(self, query, body):
        url = self.base + ("?" + urllib.parse.urlencode({"query": query}) if query else "")
        req = urllib.request.Request(url, data=body, headers=self.headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:  # default context: TLS verified
                return r.read().decode()
        except urllib.error.HTTPError as e:  # never echo headers/URL
            raise SystemExit(f"ClickHouse HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")
        except Exception as e:
            raise SystemExit(f"ClickHouse unreachable ({type(e).__name__})")

    def _select(self, sql):
        out = self._post("", (sql.rstrip().rstrip(";") + " FORMAT JSONEachRow").encode())
        return [json.loads(l) for l in out.splitlines() if l.strip()]

    def latest(self, card_id):
        # card_id already validated against CARD_RE (no quotes possible)
        r = self._select(f"SELECT version, source_sha256 FROM cairn_cards WHERE card_id = '{card_id}' ORDER BY version DESC LIMIT 1")
        return (int(r[0]["version"]), r[0]["source_sha256"]) if r else (0, None)

    def insert(self, row):
        self._post("INSERT INTO cairn_cards FORMAT JSONEachRow", json.dumps(row).encode())

    def select_latest(self, card_id=None):
        w = f"WHERE card_id = '{card_id}' " if card_id else ""
        return self._select(f"SELECT * FROM cairn_cards {w}ORDER BY card_id, version DESC LIMIT 1 BY card_id")


def backend(a):
    if a.sqlite:
        return SQLiteBackend(a.sqlite)
    if not os.environ.get("CLICKHOUSE_URL"):
        raise SystemExit("CLICKHOUSE_URL not set (source cairn/env-clickhouse.sh) or pass --sqlite FILE")
    return ClickHouseBackend(os.environ["CLICKHOUSE_URL"])


def now_str():
    d = datetime.now(timezone.utc)
    return d.strftime("%Y-%m-%d %H:%M:%S.") + f"{d.microsecond // 1000:03d}"


def cmd_sync(a, be):
    files = sorted(p for p in glob.glob(os.path.join(a.cards_dir, "*.md")) if os.path.basename(p) != "README.md")
    added = same = bad = 0
    print(f"Backend: {be.name}")
    for p in files:
        name = os.path.basename(p)
        try:
            row = parse_card(p)
        except ValidationError as e:
            print(f"SKIP {name}: {e}", file=sys.stderr)
            bad += 1
            continue
        ver, sha = be.latest(row["card_id"])
        if sha == row["source_sha256"]:
            print(f"unchanged  {row['card_id']} v{ver}")
            same += 1
            continue
        row["version"] = ver + 1
        row["created_at"] = now_str()
        be.insert(row)
        print(f"inserted   {row['card_id']} v{row['version']}  sha {row['source_sha256'][:12]}")
        added += 1
    print(f"done: {added} inserted, {same} unchanged, {bad} rejected")
    if bad:
        sys.exit(2)


def cmd_list(a, be):
    rows = be.select_latest()
    print(f"Backend: {be.name}  (latest version per card)")
    print(f"{'card_id':28} {'ver':>3} {'status':8} {'class':18} {'severity':22} created_at")
    for r in rows:
        print(f"{r['card_id']:28} {int(r['version']):>3} {r['status']:8} {r['class']:18} {r['severity'][:22]:22} {r['created_at']}")


def cmd_show(a, be):
    if not CARD_RE.match(a.card_id):
        raise SystemExit("invalid card id")
    rows = be.select_latest(a.card_id)
    if not rows:
        raise SystemExit(f"no card {a.card_id}")
    r = rows[0]
    print(f"# {r['card_id']}  v{r['version']}  status={r['status']}  class={r['class']}  severity={r['severity']}")
    print(f"seed: {r['seed']}\ncreated_at: {r['created_at']}  sha256: {r['source_sha256']}")
    for f, t in (("behavior", "Behavior"), ("why", "Why it matters"), ("recognize", "How to recognize it"),
                 ("known_copies", "Known copies"), ("safe_pattern", "Safe pattern"), ("verification", "Verification")):
        print(f"\n## {t}\n{r[f]}")


def main():
    p = argparse.ArgumentParser(description="Sync behavior cards into append-only cairn_cards")
    p.add_argument("--sqlite", help="use this SQLite file instead of ClickHouse")
    p.add_argument("--cards-dir", default=CARDS_DIR)
    s = p.add_subparsers(dest="cmd", required=True)
    s.add_parser("sync").set_defaults(f=cmd_sync)
    s.add_parser("list").set_defaults(f=cmd_list)
    x = s.add_parser("show"); x.add_argument("card_id"); x.set_defaults(f=cmd_show)
    a = p.parse_args()
    a.f(a, backend(a))


if __name__ == "__main__":
    main()
