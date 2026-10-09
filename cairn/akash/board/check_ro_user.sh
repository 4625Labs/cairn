#!/usr/bin/env bash
# Prove cairn_ro can SELECT but not INSERT/DROP/CREATE.
# Needs in the ENVIRONMENT (never from files): CLICKHOUSE_URL (https://host:8443), CLICKHOUSE_RO_USER, CLICKHOUSE_RO_PASSWORD
# Password goes to curl via stdin config (-K -), so it never shows in the process list.
set -u
: "${CLICKHOUSE_URL:?set CLICKHOUSE_URL}" "${CLICKHOUSE_RO_USER:?}" "${CLICKHOUSE_RO_PASSWORD:?}"
q() { # $1 = SQL; prints "HTTP <code>" and first line of body
  local out
  out=$(printf 'header = "X-ClickHouse-User: %s"\nheader = "X-ClickHouse-Key: %s"\n' "$CLICKHOUSE_RO_USER" "$CLICKHOUSE_RO_PASSWORD" \
    | curl -sS -m 30 -K - -w '\nHTTP %{http_code}' --data-binary "$1" "$CLICKHOUSE_URL/" 2>&1)
  printf '%s\n' "$out" | tail -2 | tr '\n' ' ' | cut -c1-200; echo
  printf '%s' "$out" | tail -1
}
fail=0
check() { # name expect(ok|denied) sql
  echo "--- $1"; res=$(q "$3"); echo "$res" | head -1
  code=$(echo "$res" | tail -1 | sed 's/HTTP //')
  if [ "$2" = ok ] && [ "$code" = 200 ]; then echo "PASS"; 
  elif [ "$2" = denied ] && [ "$code" -ge 400 ] 2>/dev/null; then echo "PASS (refused)";
  else echo "FAIL"; fail=1; fi
}
check "SELECT cairn_events"  ok     "SELECT count() FROM cairn_events"
check "SELECT cairn_cards"   ok     "SELECT count() FROM cairn_cards"
check "INSERT refused"       denied "INSERT INTO cairn_events (kind) VALUES ('ro_probe')"
check "DROP refused"         denied "DROP TABLE cairn_events"
check "CREATE refused"       denied "CREATE TABLE cairn_ro_probe (x UInt8) ENGINE=Memory"
[ $fail = 0 ] && echo "ALL OK: cairn_ro is read-only" || { echo "PROBLEM: see FAIL above"; exit 1; }
