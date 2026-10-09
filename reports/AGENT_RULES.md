# Rules for every Cairn sub-agent

Project root: /Users/4625labs/Workspace/cyberdefence-hackathon (read PLAN.md, Revision 2, and reports/*.md first).

1. Write ONLY inside the project root, and only in the directories your task names. esptember (/Users/4625labs/Workspace/pet-projects/esptember) and stopwatch-screensaver are READ-ONLY. Copy files you need into the project root.
2. NEVER git push, commit to esptember, or push to any remote. Do not run `git init`/commit inside the project root either. The GitHub sandbox repo 4625Labs/cairn-sandbox exists but is NOT to be touched by you.
3. NEVER flash, erase, reset, or write to the USB device, and do not open its serial port (/dev/cu.usbmodem*). Compile only.
4. No sponsor sign-ins, no leases, no data sent anywhere. Downloads of public toolchain files into project-root `toolchain/` are allowed (Pavan approved). Do not install anything system-wide (no brew, no sudo, no global npm/pip). Use local dirs / `uvx` / `npx` caches.
5. Mark anything you could not verify as UNVERIFIED. Do not claim tests pass unless you ran them and saw them pass; quote the final lines of the output.
6. When done, write reports/<your-id>.md (what you built, how to run it, results, open problems, anything needing Pavan's approval) and end with a 6-line summary.
7. Time is tight (submit 4:30 PM, Day 35 compile go/no-go at 2:00 PM). Prefer the simplest thing that works; report blockers early instead of grinding.
