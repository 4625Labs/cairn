# Akash scanner: Pavan's checklist (about 15 min, cents of cost)

What this does: rents a tiny machine that gets NO secrets. It runs the public image `semgrep/semgrep:1.180.0`, clones the PUBLIC repo
https://github.com/chantastic/esptember.git (same commit 2ea26363 as our seeds, verified byte-identical), runs our two rule files
(embedded in the SDL), prints findings between CAIRN-SCAN-BEGIN/END, sleeps 30 min, then the container restarts (it repeats the scan; harmless).
The provider can read everything in deploy.yaml: it contains only public rules + a public repo URL. Nothing to redact.

Before: `python3 cairn/akash/scanner/build_sdl.py` regenerates deploy.yaml (5.7 KB) if rules change.

1. Open https://console.akash.network and sign in (your existing account). Check the balance shown. UNVERIFIED: docs disagree on trial credit ($1 no card vs $100 with card). Trial deployments auto-close after 24 h.
2. Click Deploy (UNVERIFIED label: "Deploy" / "New Deployment"), choose the option to build/upload your own SDL (UNVERIFIED label: "Build your template" or "Empty/Custom SDL"), and paste the whole contents of `cairn/akash/scanner/deploy.yaml`. Console should show no SDL validation errors.
   - If it errors about a missing `expose`: add under the service `expose: [{port: 80, as: 80, to: [{global: false}]}]` (UNVERIFIED that it is needed; expose is omitted on purpose so nothing is public).
   - If it errors on `denom: uact`: try `uakt` (docs conflict).
3. Click Create Deployment (UNVERIFIED label), approve the deposit (UNVERIFIED: minimum, probably a few dollars or trial credit; unspent escrow comes back when you close).
4. Wait for bids (UNVERIFIED how long; docs give no number, expect under a few minutes). You should see a list of providers with a price. Pick the CHEAPEST that is not an obvious outlier or untrusted; audited providers are preferable (UNVERIFIED badge). If no bids after ~5 min: close the deployment and recreate with `amount: 1000` in the pricing block.
5. Click Accept Bid / Create Lease (UNVERIFIED label) and approve the wallet/credit prompt.
6. Open the deployment, tab LOGS (UNVERIFIED tab name). Within roughly 1-2 min (image pull) you should see:
   `CAIRN-INFO cloned https://github.com/chantastic/esptember.git @ 2ea26363...`, `CAIRN-SCAN-BEGIN akash-esptember`, about 50 JSON lines, `CAIRN-SCAN-END akash-esptember`, and
   `CAIRN-SUMMARY scan=akash-esptember semgrep_rc=0 findings=50 errors=1` (local simulation gave 50 on the full clone; semgrep also prints one partial-parse error for portal.c, that is the "errors=1").
   If you see `CAIRN-ERROR`, copy the line to me. Likely causes: image has no git (script tries `apk add git`), or no network from the provider.
   Also check the Events tab (UNVERIFIED) if logs stay empty: image pull errors show there.
7. Save the logs: copy the whole log pane (or use a Download logs button if present, UNVERIFIED) into `cairn/akash/akash-logs.txt`.
8. Ingest: `python3 cairn/akash/scanner/ingest_logs.py cairn/akash/akash-logs.txt > cairn/out/akash-events.jsonl` then
   `python3 events/cairn_log.py append < cairn/out/akash-events.jsonl`. Expect stderr `ingest_logs: 50 events (2 finding, 48 cousin_candidate) from 1 block(s)` (counts may differ if the repo changed).
9. CLOSE THE DEPLOYMENT: Deployment page -> Close (UNVERIFIED label) -> confirm. The container sleeps 30 min and restarts forever, so it bills until closed. Confirm it disappears from the active list and the balance stops dropping.

Cost: 0.5 CPU / 512Mi / 1Gi at `amount: 100` is a max bid of 100 uact per block (UNVERIFIED units); expect cents per day. Do not leave it overnight.
Do not paste any API key, token or password into the SDL or env. There are none and none are needed.
