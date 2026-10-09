# Cairn demo script (draft 1, written 2:10 PM, demo at 5:00 PM)

**One sentence:** Cairn turns each security mistake into a lasting plain-English lesson, checks everywhere else that mistake hides, lets an AI agent propose the fix without ever holding your keys, checks the agent's work independently, and makes a person approve it on a physical device.

**Length:** about 5 minutes. Device in hand. Four beats plus a 20-second close.

## What is real (say this honestly if asked)

- Real vulnerable code from the public esptember project. Seed bug: Wi-Fi name pasted into a web page unescaped (`portal.c`). Dependency bug: `"*"` version pin.
- Real Semgrep (rules written by us) finds the seed and its cousins: 49 rows on the seed set (2 findings, 47 cousin candidates, some noisy).
- Real ClickHouse Cloud table (`cairn_events`), append-only by convention; SQLite copy has triggers that block UPDATE and DELETE.
- Real Guild-hosted agent opened a real PR on `4625Labs/cairn-sandbox` (PR #1) with no GitHub token in the agent.
- Real Agent Dial firmware on the real M5Stack Stopwatch. A person presses a button to approve or deny.
- NOT real / not claimed: Pi has no public API, so behavior cards are plain files and we make no Pi integration claim. Akash and the Guardian hook are only claimed if done (see status table at the end).

## Setup before going on stage (do once, 4:15 PM)

1. Hub running: `cd target/agent-dial/host && node hub.mjs &` then `node bin/agent-dial.mjs status` shows `attached: true`.
2. Dial shows "0 Sessions". Screen awake (press a button).
3. `source cairn/env-clickhouse.sh` in the demo terminal.
4. Open in browser tabs: PR #1 on cairn-sandbox; the ClickHouse console query editor.
5. Reset the work copy: `rm -rf target/work target/work-verify cairn/out/pr`.
6. Backup video recorded and open in a tab.

## Beat 1 (60 s): Learn, then find the cousins

**Say:** "Every team fixes a bug once and the same mistake comes back. Cairn writes the lesson down as a card in plain English, not a regex."

- Show `cards/unvalidated-network-input.md` (the Behavior section only).
- Run: `cairn/sweep --target target/seeds --out cairn/out/sweep-demo.jsonl`
- **Point at:** one seed finding at `portal.c:113`, then the cousins: form parsing in the same file, the hub's `JSON.parse` trust in `hub.mjs`, `atoi` calls in the device code, and the `"*"` dependency pins.
- **Honest line:** "Semgrep matches code shape, so some of these are noise. The card is the memory; the scanner is replaceable."

**Fallback:** open `cairn/out/sweep-seeds.jsonl` (already produced).

## Beat 2 (45 s): Remember it

**Say:** "Every finding, every agent action, every ignored warning is an append-only row. One query answers: is this one problem, and is it spreading?"

- Run: `cairn/ingest < cairn/out/sweep-demo.jsonl | python3 events/cairn_log.py append`
- Run: `python3 events/cairn_log.py spread --card unvalidated-network-input` (live ClickHouse Cloud).
- Run: `python3 events/cairn_log.py incident --window 10m` on the demo dataset: `--demo`.
- **Point at:** the SQL printed under the answer. "ClickHouse's value here is the question, not a dashboard."

**Fallback:** `--demo` flag reads `events/demo.db` (synthetic data, labelled).

## Beat 3 (90 s): Fix it without giving the agent your keys

**Say:** "The fixer runs on Guild. It holds no GitHub token. Guild's proxy hands it a short-lived one per call. It can open a PR; it cannot merge."

- Show the saved PR #1 on cairn-sandbox. Point at: one file changed, branch `cairn/fix-unvalidated-network-input`, `main` protected.
- **Tell the real story:** "The agent did fix the bug, but while retyping the file it also typo'd `ESP_ERROR_CHECK`, `httpd_start`, even `</select>`. That file would not compile."
- Run the independent check: `python3 cairn/fix/run.py verify --patch cairn/out/guild/pr1.patch` (the hygiene gate from agent E8; check E8's report for the exact output before the demo).
- **Point at:** `GATE: BLOCK`, naming the unrelated changed lines. "The agent never checks its own homework. Nothing reaches a person unless the independent scan is clean and the test passes."
- Optional if time: `python3 cairn/fix/run.py --sim --sabotage` shows a patch that leaves the bug in place being refused.

**Fallback:** the screenshot of PR #1 and the saved gate output in `reports/E8.md`.


## Beat 3b (45 s, optional): The hook that cannot block

**Say:** "Semgrep Guardian scans every file an agent writes, but it runs after the write and cannot stop it. Here the agent was told 4 problems and left the code as it was."

- In a second terminal tab (already run, session kept open): show the Guardian output, "1 scan this session across 1 file, 4 findings" for `target/guardian-demo/app.py` (shell=True, md5, debug=True).
- Run: `python3 events/cairn_log.py ignored` and point at the `agent_ignored_finding` row.
- **Point at:** this is why Cairn adds its own gate: nothing becomes a PR unless an independent re-scan is clean.

## Beat 4 (90 s): A person approves, on the device

**Say:** "When the check is clean, the request goes to the one place a person can't be bypassed: a button on my wrist."

- Run: `python3 cairn/fix/run.py --sim-answer allow` WITHOUT `--sim`, so it asks the real Stopwatch. (Confirm flag names in E6's report before the demo; the normal run uses `--sim` only for the fake dial.)
- The dial shows "Apply Cairn fix to portal.c?" Press BtnB (right) to focus Allow, both buttons together to select.
- **Point at:** the terminal printing `Allow`, the patch and PR description written under `cairn/out/pr/`, and "nothing pushed".
- Press Deny once to show it writes nothing.

**Fallback:** `--sim` with the simulated dial (`agent-dial sim --auto allow`). Say plainly that it is simulated.

## Close (20 s): It keeps watching

**Say:** "Tomorrow someone reintroduces the bug. The card is the check. Cairn re-runs, a new row appears, and a second fix is proposed. The cards are the asset that grows."

- Run the sweep on a copy with the bug put back (`portal.c` from seeds vs `portal.fixed.c`), show the seed reappear.

## If asked

- **Why not just Semgrep?** It finds a bug. It does not remember why, find cousins by behavior, or enforce a human approval.
- **What is the Guild default gotcha?** New credentials start allow-all. We scoped the GitHub app to one repo and (if done) wrote a DENY policy. Merge is not even offered as a tool.
- **Is the device necessary?** It is the approval gate made physical. A terminal prompt also works and is the fallback.
- **What would you build next?** Point Cairn at your company's private repos; cards for unvalidated input and risky dependencies are the first two.

## Status of each beat's claims (fill in at 4:00 PM)

| Item | Status |
|---|---|
| Semgrep sweep, cards | Done |
| ClickHouse Cloud: append and spread queries | Done (append and spread run live) |
| ClickHouse: incident query on live data | Not run on live data, demo data only |
| Guild agent opens PR | Done (PR #1) |
| Hygiene gate blocks PR #1 | Done (E8): 9 out-of-scope lines and 6 identifier typos named |
| Dial approve/deny round trip | Done once on device (Allow) |
| Gate to dial, end to end on device | Done: GATE PASS, real dial answered Allow, rows in ClickHouse (pr_gate, device_approval) |
| Guild DENY policy | Applied: DENY (merge, delete, update_ref) + ALLOW (9 fixer ops), allow-all row removed. Resources not scoped in Guild; repo scope comes from the GitHub App install (cairn-sandbox only) |
| Semgrep Guardian hook live | Done: 1 scan, 4 findings on app.py; agent kept the lines; logged to ClickHouse (agent_ignored_finding) |
| Akash scanner lease | Done: scan ran on Akash (50 findings, `semgrep_rc=0`), logs saved to cairn/akash/akash-logs.txt, 50 `akash-scanner` rows ingested into ClickHouse, lease closed. SDL needed a global `expose` (provider rejected 'zero global services') |
| Cairn Board on Akash | Done: http://ciciqc4cehdq95evsfu326vj9k.ingress.h6i-dedicated.eu-se-1.digitalfrontier.so (first provider's ingress 404'd although the container was healthy; redeployed on digitalfrontier). Uses read-only ClickHouse user cairn_ro |
