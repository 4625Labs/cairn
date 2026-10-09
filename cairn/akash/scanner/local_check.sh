#!/bin/sh
# Runs the exact container script (run.sh) locally via uvx semgrep against target/seeds (same bytes as the public clone).
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
RULES_DIR="$ROOT/cairn/rules" TARGET="${TARGET:-$ROOT/target/seeds}" SEMGREP="${SEMGREP:-uvx semgrep}" \
SLEEP_SECS=0 SCAN_ID="${SCAN_ID:-local}" sh "$HERE/run.sh"
