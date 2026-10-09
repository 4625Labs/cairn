# Cairn demo talk track (plain language)

Each beat has **Say** (read as written), **Do** (what you type or press) and **Why it matters** (what is actually happening, for Q&A). Slide numbers refer to `demo/presentation/index.html`. Total: about 5 minutes. Full command and fallback details are in `demo/DEMO.md`.

## Before you start

- Run `node target/agent-dial/host/bin/agent-dial.mjs status` and check `"attached": true`. The dial should show "0 Sessions".
- Press a button once to wake the dial (it sleeps after 5 minutes, and the first press only wakes it).
- In the demo terminal: `source cairn/env-clickhouse.sh`. Run one ClickHouse query about 5 minutes ahead so the cloud service is awake (a cold start took 20 s).
- Open the deck in fullscreen (`f`; `n` shows speaker notes).

## Beat 0: The problem (30 s) · slides 1-3

**Say:** "Every software team fixes a security bug once, and then the same *kind* of mistake comes back somewhere else. Two kinds hurt us most: code that trusts input it shouldn't, and dependencies pinned to 'any version'. And now AI coding agents write much of our code, so they repeat those mistakes faster. Cairn is a robot that remembers each mistake as a plain-English lesson, hunts for the same mistake everywhere, fixes it safely, and keeps watching."

**Why it matters:** The lesson is stored as a *card* in plain English, not a pattern-matching rule, so it survives swapping tools.

## Beat 1: Find the cousins (60 s) · slide 5

**Do:** `cairn/sweep --target target/seeds --out cairn/out/sweep-demo.jsonl`

**Say:** "I give Cairn one confirmed bug: a Wi-Fi network name pasted into a web page without cleaning it. Semgrep, a code scanner, confirms it. Now watch Cairn look for relatives."

**Point at:** one **finding** at `portal.c:113`, then the **cousins**: more unchecked input in the same file, a message handler that trusts what it is sent, and dependencies set to "any version". **49 rows: 2 findings and 47 cousin candidates.**

**Say (honest line):** "Semgrep matches code shapes, so some of these are noise. The card is the memory. The scanner can be swapped."

**Why it matters:** One bug becomes a search across everything, and you stay honest about false positives.

**Fallback:** open `cairn/out/sweep-seeds.jsonl` (already produced).

## Beat 2: Remember it (45 s) · slide 6

**Do:** `python3 events/cairn_log.py spread --card unvalidated-network-input`, then open the **Cairn Board** in the browser (local: `http://127.0.0.1:8099`, or the Akash-hosted copy).

**Say:** "Everything Cairn sees is written to ClickHouse as a row that is only ever added, never edited. One question answers whether this is a one-off or spreading. Here is the same data in a small web app we host on Akash."

**Point at:** the SQL under the answer, the card list, and the "is it one incident?" panel.

**Why it matters:** An append-only log cannot be quietly rewritten, so you can trust it afterward.

**Fallback:** `--demo` flag reads `events/demo.db` (synthetic, labelled).

## Beat 3: Fix it without giving the AI your keys (90 s) · slides 7-8

**Do:** open PR #1 on the sandbox repo, then run
`python3 cairn/fix/run.py verify --patch cairn/out/guild/pr1.patch --sim`

**Say:** "A fixer agent runs on Guild. It holds no GitHub password. Guild's proxy hands it a short-lived pass for each action. It can open a pull request, but it can't merge. It did fix the bug. But look what it also did while retyping the file."

**Point at:** `eSP_ERROR_CHECK`, `nvo_erase_all`, `</celect>`.

**Say:** "It silently broke the file. That file would not compile. Cairn doesn't take the agent's word. A separate check blocks it: **9 changed lines outside the fix, 6 suspected typos.** Nothing reached a human."

**Why it matters:** The agent never grades its own homework.

**Fallback:** screenshot of PR #1 and the saved gate output in `reports/E8.md`.

## Beat 3b (optional, 30 s): The hook that can't block · slide 8

**Do:** `python3 events/cairn_log.py ignored`

**Say:** "Semgrep's own hook watches every file an AI writes, but it only reports afterward. In our test it flagged four problems and the agent left them. That's why our gate sits in front of the human."

## Beat 4: A person approves, on the device (90 s) · slide 9

**Do:** hold the Stopwatch up and run `python3 cairn/fix/run.py` (no `--sim`).

**Say:** "Now a clean patch. The terminal runs the checks and the unit test. When they pass, the request goes to the one place no software can bypass: a button on my wrist."

**Do:** when the question appears, move focus with BtnA (left) or BtnB (right), then press **both together** to choose **Allow**.

**Point at:** `agent-dial exit=0 stdout='Allow'` and "Nothing pushed."

**Why it matters:** The robot writes the patch to files and stops. A human, with a physical button, decides.

**Optional:** run it again and press **Deny**. Nothing is written (exit 3).

**Fallback:** `python3 cairn/fix/run.py --sim` uses a simulated dial. Say plainly that it is simulated.

## Beat 5: It keeps watching (30 s) · slide 10

**Do:** `cairn/sweep --target target/work --out /tmp/guard.jsonl`, then put the bug back (copy `portal.c` from `target/seeds` over `target/work`) and rerun.

**Say:** "Tomorrow someone reintroduces the bug. The card is still the check. Cairn catches it again."

**Careful:** the sabotage test leaves the bug in `target/work`. Run the Allow flow first so the tree is patched, then sweep.

## Close (20 s) · slides 11-15

**Say:** "We also ran the untrusted scanner on a rented Akash machine with no secrets in its instructions, and hosted this dashboard there too. Today the dial speaks USB; Wi-Fi is the next step. Next, point it at our company's private repos. The card library grows, and the same mistake stops coming back."

## What to avoid saying

- Do not claim a Pi integration (Pi has no public API), and do not say the scanner is perfect.
- The Akash provider can read the manifest, which is why the dashboard uses a read-only database user.
- Say plainly when anything is simulated.

## If something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| Question does not appear after the gate passes | Dial asleep, or hub not attached | Press a button, check `status`; the question stays open 2 minutes |
| `ClickHouse unreachable` | Service cold | Wait 20 s and rerun, or `CAIRN_BACKEND=sqlite` |
| Buttons do nothing | Not on the question screen | Fall back to `--sim` and say it is simulated |
| Dial shows "Not connected" | Hub stopped | Restart the hub: `cd target/agent-dial/host && node hub.mjs &` |

## After the demo

Close the Akash Board deployment, delete the Akash API key, and `DROP USER cairn_ro` in ClickHouse.
