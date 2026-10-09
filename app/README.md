# Cairn Board

Read-only dashboard for Cairn. One file (`server.mjs`, ~19 KB), Node built-ins only (tested on Node v26.10; needs Node 18+ for `fetch`), no npm, no build step, no JavaScript sent to the browser.

## Run
Demo, no credentials (reads `fixtures/*.json`, UI is labelled DEMO):

    DATA_SOURCE=fixture node app/server.mjs        # http://localhost:8080

Live ClickHouse:

    CLICKHOUSE_URL=https://HOST:8443 CLICKHOUSE_USER=readonly_user CLICKHOUSE_PASSWORD=... node app/server.mjs

## Env vars
| Var | Meaning |
|---|---|
| `PORT` | listen port, default 8080 (binds 0.0.0.0) |
| `DATA_SOURCE` | `fixture` or `clickhouse`. Default: `clickhouse` if `CLICKHOUSE_URL` is set, else `fixture` |
| `CLICKHOUSE_URL` | `https://host:port`, no credentials inside (http only for localhost) |
| `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` | sent as `X-ClickHouse-User` / `X-ClickHouse-Key` headers only |
| `FIXTURE_DIR` | override fixtures folder (default: `fixtures/` next to server.mjs; needs `cards.json`, `events.json`) |

## Routes (GET only; anything else is 405)
`/` (cards with live stats, incident panel, last 50 events; `?window=10m|1h|1d|7d`), `/card/<id>` (id must match `^[a-z0-9-]{1,64}$`), `/healthz`. Everything else is 404.

## ClickHouse needs
Tables `cairn_events` (ts, kind, card_id, repo, file, line, actor, tool, detail, verdict) and `cairn_cards` (card_id, version, created_at, status, class, severity, seed, behavior, why, recognize, known_copies, safe_pattern, verification, source_sha256, raw_markdown). A read-only user with SELECT on both is enough. The app sends only constant SELECT statements; the card id and incident cutoff go as `param_*` query parameters. 60 s timeout per query (cold start tolerant), results cached 5 s.

## Akash
Inline the file into the SDL command of a stock `node` image and set the env vars above (use SDL secrets handling for the password). Fixture mode needs the two JSON files too; for Akash use `clickhouse` mode.

## Security notes
All values HTML-escaped; CSP `default-src 'none'`, nosniff, no cookies, 8 KB header limit, 200-char URL limit, no secrets in responses or logs (logs hold method, truncated path, status). Errors shown to the page are generic.
