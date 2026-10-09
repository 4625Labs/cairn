# Cairn: implementation plan (draft 1, no code yet)

> A cairn is a stack of stones that marks a trail so the next traveler doesn't repeat the last one's mistake.
> Cairn is a robot that turns each security mistake into a lasting, plain-English lesson and keeps checking for it.

## Ground rules (set by Pavan)

1. **Never push to any repo without asking first.** No exceptions, including this folder if it ever becomes a repo.
2. **Work only inside `/Users/4625labs/Workspace/cyberdefence-hackathon`.**
3. **esptember is read-only reference.** It is public. Anything we need to change is copied into `target/` here and changed there.
4. **Plan first, then code.** No building until this plan is approved.
5. The main agent (me) is the coordinator. Sub-agents each own one deliverable and report back to me. They follow the same rules.

## Problem statement

Teams fix security bugs one instance at a time, so the same class of mistake keeps coming back. Two classes hurt Pavan's company repos most: **unvalidated input** and **risky dependencies**. Nothing remembers which classes have already bitten the team, where else they hide, or whether a fix held.

## Target: esptember, with the device demo on Day 35 "Agent Dial"

I read the specs, not the firmware, so this is a first pick to confirm.

**Why Agent Dial (Day 35):**
- It is the device that shows your AI agent sessions and lets you **approve or deny a tool call, answer a question, or stop a turn** with the Stopwatch's buttons.
- That is exactly Guild's rule, "the agent proposes, a person approves," as a physical object. **The human merge gate becomes a button on your wrist.**
- It has a host-side hub, so it has real input handling and real dependencies to scan.
- Pavan has the device, and Day 35 already has a working on-device test harness (`check_device.py`).

**Sweep targets (read-only scan, no device needed):** Day 22 (captive portal forms), 23 (weather JSON), 27 (package tracker), 31 (AuthKit), the Astro site's `package.json`/`pnpm-lock.yaml`, and each `idf_component.yml`.

## Demo story (about 5 minutes, device in hand)

1. **Learn.** Cairn is shown one real or planted bug and writes a plain-English card, e.g. "text from the network is used without a length or type check."
2. **Sweep.** The card is run across the copy of esptember. Result: one seed plus cousins, listed in the log.
3. **Fix.** A fixer agent writes a patch in `target/` and prepares a PR description. It never holds a GitHub token. Every write is re-scanned.
4. **Approve on the device.** The agent's "open PR / apply patch" request appears on the Stopwatch. Pavan presses a button to approve. **This is the demo moment.**
5. **Guard.** The bug is reintroduced. The card catches it, a new log row appears, and a second fix is proposed.

## Architecture: swappable slots

| Slot | What it does | Sponsor | Fallback if not ready |
|---|---|---|---|
| Detect | Confirm the seed bug and re-scan patches | Semgrep (Guardian hook + CLI) | Semgrep CLI by hand |
| Cards | Plain-English behavior cards in versioned files, used to find cousins | Pi's idea, built as files | Same, no dependency |
| Record | Append-only event log and the "is it one incident / spreading" query | ClickHouse | Local SQLite with the same schema |
| Act | Fixer agent, tokenless, opens a PR draft | Guild | Local agent, patch saved as a file |
| Isolate | Scanner container on a rented machine | Akash | Run in local Docker |
| Approve | Human gate on the Stopwatch | Agent Dial hardware | Terminal prompt |

Cards are the permanent asset. Every slot above can be swapped without losing them.

## Folder layout (to be created after approval)

```
cyberdefence-hackathon/
  PLAN.md
  ideation.md
  cards/              # behavior cards, one file each
  target/             # copy of esptember we are allowed to modify (planted bugs live here)
  cairn/              # the robot: sweep, fix, guard
  events/             # event schema and queries
  demo/               # script, rehearsal notes
  reports/            # sub-agent reports back to the coordinator
```

## Event schema (one table, append-only)

`ts, kind, card_id, repo, file, line, actor, tool, detail, verdict`
Kinds: `finding`, `cousin_candidate`, `human_confirm`, `agent_write`, `agent_ignored_finding`, `pr_gate`, `device_approval`, `reintroduced`.

## Sub-agents and what they report

| Agent | Job | Reports back |
|---|---|---|
| **A. Recon** | Read esptember's hub and firmware plus Days 22/23/27/31 and list real unvalidated-input and dependency issues, with file and line | `reports/recon.md` |
| **B. Cards** | Draft the first two cards (`unvalidated-network-input`, `unpinned-dependency`) from Recon's evidence | `cards/*.md` |
| **C. Sponsors** | Check what is actually usable today: Semgrep Guardian install, ClickHouse access, Guild and Akash credentials, Pi's public info | `reports/sponsors.md` |
| **D. Device** | Confirm Day 35 flashes and runs on Pavan's Stopwatch, and find the hook point where an approval request can come from Cairn | `reports/device.md` |
| **E. Build** | After approval: sweep, event log, fixer loop | working code in `cairn/` |
| **F. Demo** | Script, rehearsal, fallbacks | `demo/` |

A, C and D can run in parallel now (they are read-only or check-only). B waits for A. E and F wait for plan approval.

## Order of work (about 5 hours left)

| Block | Work | Cut line |
|---|---|---|
| Now to +0:30 | Approve plan, Recon, Sponsors and Device in parallel | none |
| +0:30 to +1:30 | Cards, `target/` copy with planted bugs, Semgrep sweep | none |
| +1:30 to +2:30 | Event log, "one incident?" query | none |
| +2:30 to +3:30 | Fixer loop, PR gate, device approval | device falls back to terminal prompt |
| +3:30 to +4:15 | Guard demo, Akash lease | **cut Akash first**, then Guild |
| Last 45 min | Rehearse twice, record a backup video | no new features |

Never cut: Semgrep, the cards, the log, the device approval.

## Risks

- **Day 35 may not run on the device in time.** Mitigation: Device agent checks this first. Fallback is a terminal prompt, though the demo is weaker.
- **Sponsor credentials may not be ready.** Every slot has a local fallback.
- **Flashing could affect the device's saved state.** Esptember notes a full-image flash erases saved touch calibration. We use app-only writes, as that repo's own notes advise, and ask before flashing anything.
- **Cards found by AI can be wrong.** A human-confirm event is logged before any fix.

## Open questions for Pavan

1. Is Day 35 Agent Dial the right device demo, or does another day matter more to you?
2. Is the device already flashed with Day 35, or something else?
3. Which of Guild, Akash, ClickHouse and Semgrep do you already have accounts for?
4. Do you approve launching Recon, Sponsors and Device agents now (all read-only)?

---

# Revision 2 (12:20 PM, after the three recon reports)

Decision by Pavan: **build the full Day 35 Agent Dial.** The small "Cairn Gate" app is dropped as the plan, but kept as a fallback (see below).

## What the reports changed

- Day 35 ships **no firmware and no hub**. Both are generated from the README prompt (`days/day-35-agent-dial/README.md`, "The build prompt") and checked by the lesson's own tests (`tests/run.sh`, `check_host.mjs`, `check_frames.py`, `check_device.py`).
- The Mac has no `arduino-cli`, `esptool`, `pnpm` or `semgrep`. Toolchain goes **inside this folder** (`toolchain/`), never system-wide.
- Real vulnerable code for Cairn to find is **not** in Day 35 (it has no code). It lives in Day 34 Pi Pet (`hub.mjs`, `pi_pet.ino`, `net_link.h`) and `drafts/chan-live-captions` (`portal.c`, `auth.h`), plus 8 `idf_component.yml` files with `"*"` pins. These are copied into `target/`.
- Pi has no public API: cards are files and we do not claim a Pi integration.
- Semgrep: Guardian plugin for the live hook demo, local rules through `uvx semgrep` for the real detection.
- Guild PR needs a GitHub App on a throwaway repo. Default is a patch file until Pavan picks a repo.

## Two products, one demo

1. **Cairn** (the robot) finds the bug class, writes cards, logs events, and produces a fix.
2. **Agent Dial** (the device) is where the fixer's request to apply or open the fix appears, and Pavan approves with a physical button.

Cairn talks to the dial through `agent-dial ask` / the hub socket (`~/.agent-dial/hub.sock`) once our generated hub exists.

## Day 35 build track (time-boxed)

| Step | Owner | Output | Gate |
|---|---|---|---|
| T1 Toolchain into `toolchain/` (arduino-cli, ESP32 core 3.3.10, LVGL 9.5.0, ArduinoJson 7.4.2, M5Unified 0.2.19, M5GFX 0.2.26, esptool) | Agent E1 | compile works on a hello sketch | needs Pavan's OK to download |
| T2 Generate the **hub** and **adapters** (Node) from the prompt | Agent E2 | `target/agent-dial/host/` passes `check_host.mjs` and frame vectors | host tests only, no device |
| T3 Generate the **firmware** from the prompt | Agent E3 | compiles, size under the 3 MB app partition | compile only |
| T4 Backup, then app-only flash at 0x10000 | Coordinator + Pavan | device boots the dial | **explicit approval of the exact commands** |
| T5 Device checks (`check_device.py`) and one approve/deny round trip | Agent E3 | proof the button returns an answer | after T4 |

**Hard time box:** T1 to T3 must compile by **2:00 PM**. If not, we flash nothing new, and the device demo falls back to the small Cairn Gate firmware or a terminal prompt. Flashing is never started after 3:15 PM.

## Cairn track (runs in parallel with the Day 35 track)

| Step | Owner | Output |
|---|---|---|
| C1 Copy seed files into `target/` and revert the one-line fix to plant the bug | Agent B | `target/` with planted bugs |
| C2 Write cards `unvalidated-network-input`, `unpinned-dependency` from the recon evidence | Agent B | `cards/*.md` |
| C3 Local Semgrep rules plus the card sweep (seed plus cousins) | Agent E4 | `cairn/sweep` with JSON output |
| C4 Event log in ClickHouse (fallback SQLite) and the "one incident?" query | Agent E5 | `events/` |
| C5 Fixer loop: patch, re-scan, gate, ask the dial | Coordinator | `cairn/fix` |
| C6 Reintroduce the bug and show the guard fire | Coordinator | demo beat 5 |
| C7 Akash scanner lease | later, cut first | optional |

## Revised schedule (now 12:20, submit 4:30)

| Time | Work |
|---|---|
| 12:20 to 12:45 | Approve this revision. Install toolchain locally (T1). Plant bugs (C1). |
| 12:45 to 2:00 | T2 and T3 in parallel with C2, C3, C4 |
| 2:00 | **Go / no-go on the Day 35 device path** |
| 2:00 to 3:15 | T4, T5 if go. C5 either way. |
| 3:15 to 4:00 | Guard beat, polish, optional Akash |
| 4:00 to 4:30 | Rehearse twice, record a backup video, submit |

## Sub-agent rules (all agents)

No push, no commit to esptember or any repo, no writes outside this folder, no device flash or serial writes, no sponsor sign-ins or leases. Each agent writes one report to `reports/` and a final summary. Anything that touches the device, installs software, or leaves this machine comes back to the coordinator for Pavan's approval.

## Approvals needed from Pavan before coding starts

1. OK to download the toolchain into `toolchain/` inside this folder?
2. OK to launch build agents E1 to E5 and B (they write only inside this folder)?
3. Throwaway GitHub repo name for the fix PR, or default to a patch file?
4. Later, separately: explicit approval of the backup and flash commands (T4).
