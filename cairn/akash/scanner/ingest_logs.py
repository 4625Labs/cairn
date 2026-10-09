#!/usr/bin/env python3
"""Turn saved Akash lease logs (untrusted text) into Cairn event JSON lines. stdlib only.

  python3 ingest_logs.py akash-logs.txt | python3 ../../../events/cairn_log.py append
Takes the FIRST complete CAIRN-SCAN-BEGIN..END block (the container restarts after its sleep and would repeat it);
--all takes every block (duplicates are dropped). Every row is validated; any bad row aborts with exit 2 and prints nothing.
The provider controls these logs, so rows are data only: strict allow-list of fields, regexes, no control characters.
"""
import argparse, json, re, sys
from datetime import datetime, timezone

SEEDS = {"unpinned-dependency": "days/day-03-static-graphic/firmware/main/idf_component.yml",
         "unvalidated-network-input": "drafts/chan-live-captions/firmware/main/portal.c"}
FIELDS = {"rule_id": str, "card": str, "seed_shape": bool, "severity": str, "file": str, "line": int, "snippet": str}
CARD_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
RULE_RE = re.compile(r"^cairn\.[a-z0-9-]+\.[a-z0-9-]+$")
FILE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_./+@ -]{0,300}$")
CTRL = re.compile(r"[\x00-\x1f\x7f]")
SEV = {"ERROR", "WARNING", "INFO"}


class Bad(Exception):
    pass


def validate(o):
    if not isinstance(o, dict) or set(o) != set(FIELDS):
        raise Bad(f"fields must be exactly {sorted(FIELDS)}")
    for k, t in FIELDS.items():
        if type(o[k]) is not t:
            raise Bad(f"{k} must be {t.__name__}")
    if not CARD_RE.match(o["card"]) or o["card"] not in SEEDS:
        raise Bad("unknown card")
    if not RULE_RE.match(o["rule_id"]) or o["rule_id"].split(".")[1] != o["card"]:
        raise Bad("rule_id invalid or does not belong to card")
    if o["severity"] not in SEV:
        raise Bad("severity")
    f = o["file"]
    if not FILE_RE.match(f) or ".." in f.split("/") or CTRL.search(f):
        raise Bad("file path")
    if not (1 <= o["line"] <= 10_000_000):
        raise Bad("line range")
    if len(o["snippet"]) > 200 or CTRL.search(o["snippet"]):
        raise Bad("snippet length/control chars")
    return o


def blocks(text):
    cur, out = None, []
    for ln in text.splitlines():
        if "CAIRN-SCAN-BEGIN" in ln:
            cur = []
        elif "CAIRN-SCAN-END" in ln:
            if cur is not None:
                out.append(cur)
            cur = None
        elif cur is not None:
            i = ln.find("{")  # tolerate a log prefix such as "[scanner-0] " or a timestamp
            if i >= 0:
                cur.append((ln[i:], ln))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logfile")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--repo", default="esptember")
    ap.add_argument("--ts", help="ISO timestamp (default: now, UTC)")
    a = ap.parse_args()
    text = open(a.logfile, errors="replace").read()
    bl = blocks(text)
    if not bl:
        sys.exit("no complete CAIRN-SCAN-BEGIN..END block found (is the log saved in full? did the scan error? look for CAIRN-ERROR)")
    ts = a.ts or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows, seen = [], set()
    for b in (bl if a.all else bl[:1]):
        for js, raw in b:
            try:
                o = validate(json.loads(js))
            except (json.JSONDecodeError, Bad) as e:
                sys.stderr.write(f"REJECT ({e}): {raw[:160]!r}\n"); sys.exit(2)
            key = (o["card"], o["file"], o["line"], o["rule_id"])
            if key in seen:
                continue
            seen.add(key)
            is_seed = o["seed_shape"] and o["file"] == SEEDS[o["card"]]
            rows.append({"ts": ts, "kind": "finding" if is_seed else "cousin_candidate", "card_id": o["card"],
                         "repo": a.repo, "file": o["file"], "line": o["line"], "actor": "akash-scanner",
                         "tool": "semgrep", "detail": f"{o['rule_id']} [{o['severity']}]: {o['snippet']}",
                         "verdict": "unconfirmed"})
    for r in rows:
        print(json.dumps(r))
    k = sum(r["kind"] == "finding" for r in rows)
    sys.stderr.write(f"ingest_logs: {len(rows)} events ({k} finding, {len(rows)-k} cousin_candidate) from {len(bl)} block(s)\n")


if __name__ == "__main__":
    main()
