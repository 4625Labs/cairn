# Akash Board hosting: Pavan's checklist (about 20 min)

The Board is `app/server.mjs` run inside the stock public image `node:22-alpine` (tag verified to exist on Docker Hub, read-only API call). The file is gzip+base64 inlined in the SDL command. The Akash provider can read the whole SDL and the env values you type into the form, so the app only ever gets a throwaway READ-ONLY ClickHouse user.

Regenerate if server.mjs changes: `python3 cairn/akash/board/make_sdl.py` (gzip, 10.7 KB SDL). Fallback `--plain` (no gzip, 25.9 KB SDL). The script refuses to write if any value from `.env.clickhouse` would land in the SDL.

## 1. Create the read-only ClickHouse user
In the ClickHouse Cloud SQL console as an admin (the password is typed here, never saved in the repo; pick a fresh random one):
```sql
CREATE USER cairn_ro IDENTIFIED WITH sha256_password BY 'REPLACE_WITH_READONLY_PASSWORD';
GRANT SELECT ON default.cairn_events TO cairn_ro;
GRANT SELECT ON default.cairn_cards  TO cairn_ro;
```
Replace `default` with the database that holds the tables if different. UNVERIFIED: exact auth syntax on your Cloud plan (`IDENTIFIED BY '...'` also works in most versions). If the app's Board queries need more than plain SELECT (e.g. `SETTINGS`), grant nothing extra; report the error.

## 2. Prove it is read-only
```bash
export CLICKHOUSE_URL=https://HOST:8443 CLICKHOUSE_RO_USER=cairn_ro
read -rs CLICKHOUSE_RO_PASSWORD; export CLICKHOUSE_RO_PASSWORD
bash cairn/akash/board/check_ro_user.sh
```
Expect two SELECT PASS lines, three "PASS (refused)" lines and `ALL OK`. Do not continue if any FAIL. Then `unset CLICKHOUSE_RO_PASSWORD`.
(If the user reaches a `default`-role with more rights than expected, the INSERT/DROP lines will show FAIL.)

## 3. Open the Akash Console
https://console.akash.network, sign in, check the balance. UNVERIFIED: trial credit amount (docs say $1 or $100); trial deployments auto-close after 24 h.

## 4. Deploy from the SDL
Deploy -> custom/own SDL (UNVERIFIED label: "Build your template" / "Empty"), paste all of `cairn/akash/board/deploy.yaml` (10.7 KB). Same conventions as the scanner: `denom: uact` (if rejected try `uakt`, docs conflict), `amount: 100`.
If Console rejects the size or the command, tell me; fallback plan is in reports/A1.md (split the payload across several env vars, no public hosting needed).

## 5. Edit the three env values in the Console form
UNVERIFIED that the Console shows an editable SDL/env step before creating the deployment (docs say you can edit the SDL; otherwise edit in the pasted text). Change only:
- `CLICKHOUSE_URL=https://REPLACE_WITH_CLICKHOUSE_HOST:8443` to your real `https://HOST:8443`
- `CLICKHOUSE_USER=cairn_ro` (leave)
- `CLICKHOUSE_PASSWORD=REPLACE_WITH_READONLY_PASSWORD` to the cairn_ro password
Never save this edited text back into the repo or paste it into chat.

## 6. Create deployment, accept the cheapest bid
Approve deposit, wait for bids (time UNVERIFIED), pick the cheapest non-outlier (prefer audited providers, UNVERIFIED badge), Accept/Create Lease. If no bids after 5 min: close and recreate with `amount: 1000`.

## 7. Find the public URL
Deployment page -> Leases / Overview shows a forwarded URI for port 80 (UNVERIFIED label; it may be a provider hostname with a random port or subdomain). Check LOGS for `Cairn Board listening` style line (UNVERIFIED exact text) if it is not responding; the first pull of the 60 MB image takes a minute or two.

## 8. Verify and show
```bash
curl -s http://<URI>/healthz        # expect {"ok":true,"source":"clickhouse",...}
```
Open `http://<URI>/` in the browser: cards, incident panel, events. UI must NOT say DEMO. Note http not https unless the provider offers TLS (UNVERIFIED).

## 9. Close and clean up (do not skip)
1. Console: Deployment -> Close, confirm; the deployment must disappear from the active list.
2. ClickHouse: `DROP USER cairn_ro;`
3. Confirm: `SELECT name FROM system.users WHERE name='cairn_ro'` returns no rows.
