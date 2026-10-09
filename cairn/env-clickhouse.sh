# source this: loads ClickHouse Cloud settings from .env.clickhouse without printing them.
# Only the three variables Cairn needs are exported (not the Cloud API key/secret).
_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
for _k in CLICKHOUSE_URL CLICKHOUSE_USER CLICKHOUSE_PASSWORD; do
  _v="$(grep -E "^${_k}=" "$_root/.env.clickhouse" | head -1 | cut -d= -f2-)"
  export "$_k=$_v"
done
unset _k _v
export SSL_CERT_FILE=/etc/ssl/cert.pem   # python.org build has no CA bundle; use macOS's
