#!/bin/sh
# Cairn scanner job. Runs identically in the Akash container and locally (local_check.sh).
# Inputs (env): RULES_DIR (dir of *.yml), TARGET (dir to scan) OR CLONE_URL (public repo to clone to TARGET),
#               SEMGREP (command, default "semgrep"), SLEEP_SECS (default 0), SCAN_ID (label).
# No secrets are read or needed. Output: JSON lines between CAIRN-SCAN-BEGIN / CAIRN-SCAN-END, then a CAIRN-SUMMARY line.
set -u
SEMGREP=${SEMGREP:-semgrep}
SLEEP_SECS=${SLEEP_SECS:-0}
SCAN_ID=${SCAN_ID:-scan}
if [ -n "${CLONE_URL:-}" ]; then
  TARGET=${TARGET:-/tmp/target}
  command -v git >/dev/null 2>&1 || apk add --no-cache git >/dev/null 2>&1 || true
  rm -rf "$TARGET"
  git clone --depth 1 -q "$CLONE_URL" "$TARGET" || { echo "CAIRN-ERROR clone failed"; sleep "$SLEEP_SECS"; exit 1; }
  echo "CAIRN-INFO cloned $CLONE_URL @ $(git -C "$TARGET" rev-parse HEAD)"
fi
OUT=${TMPDIR:-/tmp}/cairn-semgrep.json
$SEMGREP --config "$RULES_DIR" --metrics=off --disable-version-check --json --quiet --no-git-ignore \
  --exclude '*.fixed.*' --output "$OUT" "$TARGET" >/dev/null 2>"${OUT}.err"
RC=$?
if [ ! -s "$OUT" ]; then echo "CAIRN-ERROR semgrep rc=$RC: $(tail -c 300 "${OUT}.err" | tr '\n' ' ')"; sleep "$SLEEP_SECS"; exit 1; fi
echo "CAIRN-SCAN-BEGIN $SCAN_ID"
python3 - "$OUT" "$TARGET" <<'PY'
import json, sys, os, re
d = json.load(open(sys.argv[1])); root = os.path.abspath(sys.argv[2]); n = 0
for r in sorted(d.get("results", []), key=lambda r: (r["path"], r["start"]["line"], r["check_id"])):
    p = os.path.abspath(r["path"]); rel = os.path.relpath(p, root)
    try:
        snip = open(p, errors="replace").read().splitlines()[r["start"]["line"] - 1].strip()[:200]
    except Exception:
        snip = ""
    m = r["extra"].get("metadata", {})
    print(json.dumps({"rule_id": re.search(r"(cairn\.[a-z0-9-]+\.[a-z0-9-]+)$", r["check_id"]).group(1) if re.search(r"(cairn\.[a-z0-9-]+\.[a-z0-9-]+)$", r["check_id"]) else r["check_id"], "card": m.get("card", ""),
        "seed_shape": bool(m.get("seed_shape", False)), "severity": r["extra"].get("severity", ""),
        "file": rel, "line": r["start"]["line"], "snippet": snip}, sort_keys=True)); n += 1
PY
echo "CAIRN-SCAN-END $SCAN_ID"
echo "CAIRN-SUMMARY scan=$SCAN_ID semgrep_rc=$RC findings=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["results"]))' "$OUT") errors=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1])).get("errors",[])))' "$OUT")"
sleep "$SLEEP_SECS"
