# Device report (Agent D): Stopwatch -> Day 35 Agent Dial

Host-only, read-only checks. Nothing was flashed, opened, or reset. No file outside this report was written.

## 1. Device detected (no contact made)
- Port: `/dev/cu.usbmodem1101` (only non-system serial port present).
- USB (ioreg): vendor Espressif (idVendor 12346 = 0x303A), product "USB JTAG_serial debug unit" (idProduct 4097 = 0x1001, the ESP32-S3 built-in USB-Serial/JTAG), serial/MAC string `28:84:85:43:98:18`.
- Note: stopwatch-screensaver `platformio.ini` hardcodes `/dev/cu.usbmodem112401`; this unit enumerates as `usbmodem1101`. The device's MAC differs from the one in Day 35 RESULTS.md (`...44:60:98`), so this is a different physical unit than the author's.
- UNVERIFIED: that this is the M5 Stopwatch (VID/PID is generic ESP32-S3). Chip revision, flash size, PSRAM, and the on-flash partition table were NOT read (reading needs esptool, which resets the chip into the bootloader; not done).

## 2. stopwatch-screensaver (currently flashed project)
- What: xscreensaver "hacks" on the M5Stack StopWatch (SKU C152, ESP32-S3, 466x466 AMOLED) via an X11 shim. PlatformIO + Arduino framework (espressif32 @ 6.12.0), board `esp32s3box`, M5Unified/M5GFX/M5PM1/M5IOE1 from pinned git commits.
- Build/flash: `source tools/env.sh; cd firmware; pio run -e stopwatch -t upload` (PlatformIO writes bootloader + partitions + app via esptool, i.e. includes 0x0-region pieces). A `.venv` PlatformIO install and `.platformio/` toolchains already exist locally inside that project (git-ignored), plus built artifacts in `firmware/.pio/build/stopwatch/` (bootloader.bin, firmware.bin).
- Partition table: `board_build.partitions = app3M_fat9M_16MB.csv` (I read the copy in its `.platformio/packages/framework-arduinoespressif32/tools/partitions/`):
  ```
  nvs      0x9000   0x5000
  otadata  0xe000   0x2000
  app0     0x10000  0x300000   (ota_0)
  app1     0x310000 0x300000   (ota_1)
  ffat     0x610000 0x9E0000
  coredump 0xFF0000 0x10000
  ```
- This is the SAME table Day 35 requires (`app3M_fat9M_16MB`). So this device very likely carries the Day 35 layout: app at 0x10000, NVS at 0x9000 (20 KB; RESULTS says factory NVS is only 16 KB and the factory app is at 0x20000, which this device does NOT match, assuming the screensaver was flashed with PlatformIO's default flow).
- NVS / calibration: grep of `main.cpp` shows no NVS/Preferences use by the screensaver. It does not write or read `espt-touch/record`. So replacing it does not destroy anything the screensaver owns; any prior touch calibration in NVS (if one was ever saved by an earlier esptember day on this unit) is UNVERIFIED but is preserved by an app-only write at 0x10000.
- Risk of replacing: none for the screensaver (source stays in its folder, rebuildable). To get the screensaver back later: `pio run -e stopwatch -t upload` (that flow writes bootloader/partitions too; harmless as the table is identical, NVS at 0x9000 not rewritten by PlatformIO upload).
- UNVERIFIED: that the screensaver was in fact flashed with this table (a PlatformIO upload would have written it; strong inference, not read from flash).

## 3. Day 35 Agent Dial: what exists and how to get a build
Folder: `/Users/4625labs/Workspace/pet-projects/esptember/days/day-35-agent-dial/` contains README.md, SPEC.md (440 lines), TESTING.md, RESULTS.md, HAND-REVIEW.md, STORY.md, LICENSE-OPENHARNESS, `tests/`.

**KEY FINDING: there is NO flashable build and NO hub/host code in the repo.** esptember is "prompt-first": the durable source is the build prompt (README) + SPEC + contract. Firmware and host code are "disposable candidates" generated under the ignored `days/day-35-agent-dial/.build/` (device-candidate/agent_dial/, host-candidate/agent-dial/). I searched esptember to depth 4: no `.build`, no `hub.mjs`, no `agent-dial*` code, no kept build. `.gitignore` excludes `.build`. The author's backup also lived only in the ignored `.build/factory-backup/`.
Consequence: to run Day 35 someone (an agent following README "The build prompt") must GENERATE firmware (Arduino C++/LVGL) and host (Node `hub.mjs`, `lib/client.mjs`, `bin/agent-dial.mjs`, pi extension) from the spec, then compile and test. This is real work (RESULTS shows several device-found defects the prompt now guards against). Plan-wise: this is the biggest risk for the demo. Per Cairn ground rules, esptember is read-only, so generation must happen in `cyberdefence-hackathon/target/` (a copy), not in esptember.

Tests in `tests/` (run without hardware): `tests/run.sh` = contract validation (uses `scripts/prompt-contract/validate_day.sh` from esptember root), `reference_model.py`, `check_frames.py` (vectors in `tests/vectors/dial_frame.txt`), and `check_host.mjs` (runs only if a host candidate exists). Device-layer scripts (stdlib + pyserial): `check_device.py` (31 scenarios, sends diag.act over serial), `capture_screens.py`. Those two WRITE to the serial port, so they are flash-day steps, not now.

Toolchain required (README front matter): Arduino ESP32 core 3.3.10, M5Unified 0.2.19, M5GFX 0.2.26, LVGL 9.5.0, ArduinoJson 7.4.2, board config ESP32-S3, OPI PSRAM, 16 MB flash, `app3M_fat9M_16MB`; Geist fonts regenerated via `lv_font_conv` (needs npm); Node for hub; pyserial for device tests.

Installed on this Mac:
| Tool | Status |
|---|---|
| node v26.10.0, npm | present (hub needs only Node; frame/serial lib may need `serialport` npm, UNVERIFIED which dependency) |
| python3 3.10.11 (/usr/local/bin) | present; pyserial NOT in system pip list |
| uv | present (~/Library/Python/3.10/bin/uv) |
| git | present |
| esptool(.py), arduino-cli, pio, idf.py, pnpm | NOT on PATH |
| Arduino cores/libs (~/Library/Arduino15, ~/Documents/Arduino) | absent |
| PlatformIO + esptool + xtensa toolchain | present ONLY inside stopwatch-screensaver (`.venv`, `.platformio/packages/{tool-esptoolpy,toolchain-xtensa-esp32s3,framework-arduinoespressif32}`). Arduino core there is 2.x-era via espressif32 6.12.0 (likely core 2.0.17, not 3.3.10; UNVERIFIED), so it does not satisfy Day 35's pinned Arduino ESP32 3.3.10 / LVGL 9.5 build. Need arduino-cli (brew) + core install into a local dir. |

Flash mode per docs: **app-only at 0x10000** if the board already has the app3M_fat9M_16MB table (this device likely does, see section 2); merged image at 0x0 only for a factory unit (fresh install, erases NVS, back up first).

## 4. Integration point for Cairn (ask/approve)
Everything goes through the local hub; code does not exist yet in the repo, but the protocol is specified in SPEC.md ("Adapter <-> hub", lines ~138-170, 400-411) and README.
Hub (to be generated): `.build/host-candidate/agent-dial/hub.mjs`, owns serial port (vendor 303a), exits after 5 idle minutes, no network listener. Auto-started by the client if a board is on USB.

Option A (simplest for Cairn): CLI
- `agent-dial ask ...` (bin/agent-dial.mjs) blocks, shows a question on the dial with a beep, prints the chosen option to stdout, exit 0 (RESULTS: "returned `Ship` with exit 0"). EXACT FLAGS UNVERIFIED: SPEC/README do not list `ask`'s argument syntax; it will be whatever the generated CLI defines. Also available: `agent-dial event` (status tiles; e.g. `--password` is redacted), `status`, `pair`, `wifi`, `release`, `install-claude`.
- Approve/deny semantics: a two-option question ("Allow"/"Deny") as Claude Code's hook does.

Option B (protocol, flexible): newline-delimited JSON over Unix socket `~/.agent-dial/hub.sock` (override `AGENT_DIAL_SOCKET`). Cairn fixer sends:
```
{"t":"hello","id":"cairn","name":"Cairn","harness":"cairn","caps":["answer"]}
{"t":"question","id":"cairn","requestId":"pr-1","questions":[{"key":"gate","q":"Open PR for fix?","multi":false,"options":["Approve","Deny"]}]}
```
and reads back on the same connection:
```
{"t":"answer","id":"cairn","requestId":"pr-1","answers":{"gate":"Approve"}}
```
Then `{"t":"question.close",...}` if resolved elsewhere, and `{"t":"bye","id":"cairn"}` at the end. The `answer` capability must be declared in `hello.caps` or answers are not routed (capability gating, SPEC line ~76). Exact field names above are from the SPEC message table (verified in text); behavior is unverified until code exists. Also usable: `turn.started {id,text}` to show "Cooking..." activity, `summary {id,text}` for a finished-turn recap + beep.
Option C: `lib/client.mjs` (hub socket first, then direct Wi-Fi from `~/.agent-dial/device.json`); no stored Wi-Fi on a fresh board, so USB-only.
For the Cairn event schema: map the `answer` to a `device_approval` event; timeout/no hub -> terminal prompt fallback (matches PLAN slot "Approve").

## 5. Minimal-risk flash plan (for user approval; NOTHING below has been run)
Pre-reqs (no device contact):
1. Decide where build is made: copy day-35 docs into `cyberdefence-hackathon/target/` and generate firmware+host there; run `tests/run.sh` (host-only).
2. Install toolchain into project-local dirs (arduino-cli + ESP32 core 3.3.10 + pinned libs; brew install is a system change, ask first). Compile; check size ~1.9 MB (< 3 MB app slot).
3. Confirm device layout and back up (device contact begins here; first esptool use resets the chip into/out of the bootloader):
   - Back up full 16 MB (NOT RUN):
     `/Users/4625labs/Workspace/pet-projects/stopwatch-screensaver/.venv/bin/python /Users/4625labs/Workspace/pet-projects/stopwatch-screensaver/.platformio/packages/tool-esptoolpy/esptool.py --chip esp32s3 --port /dev/cu.usbmodem1101 --baud 460800 read_flash 0x0 0x1000000 /Users/4625labs/Workspace/cyberdefence-hackathon/backups/stopwatch-factory-16MB.bin`
     (path to esptool in PlatformIO package UNVERIFIED; read_flash does not modify flash but does reset the chip; use `shasum -a 256` afterwards.) If the device has USB-JTAG trouble entering the bootloader, hold BOOT while plugging in.
   - Optionally read partition table first: `... read_flash 0x8000 0xC00 pt.bin` then `gen_esp32part.py pt.bin` to confirm app0 at 0x10000.
4. Flash:
   - If table confirmed (app0 @0x10000): app-only write of the Day 35 app binary at 0x10000 (`write_flash 0x10000 agent_dial.ino.bin`). NVS preserved. Screensaver app is overwritten. Boot partition selection: otadata at 0xe000 may still point to ota_0, fine; if it points to ota_1 the new app would not boot (UNVERIFIED; a PlatformIO flash normally uses ota_0).
   - If a factory table (app @0x20000): STOP; merged image at 0x0 is a fresh install that erases NVS (calibration, pairing). Needs explicit user OK.
5. Run `agent-dial pause 600` / `release` for any hub before flashing (Day 34 pi-pet hub also claims vendor 303a: pause it).
6. Verify: `tests/check_device.py` (writes serial, only after user OK), `capture_screens.py`, then a live `agent-dial ask` round trip.
7. Rollback: `write_flash 0x0 stopwatch-factory-16MB.bin` (restores everything, including NVS) or re-run screensaver `pio run -e stopwatch -t upload`.

## Confirm with the user before anything is flashed
- OK to install toolchain (arduino-cli, ESP32 core 3.3.10, libs, pyserial, lv_font_conv) and generate the host+firmware in `target/` (no pre-built Day 35 exists)?
- OK to run an esptool read (resets the device momentarily) to back up flash and read the partition table, and to store the 16 MB backup under `cyberdefence-hackathon/backups/`?
- Is losing the screensaver on the device acceptable (rebuildable from its folder)?
- Does the user have any touch calibration or Wi-Fi/pairing data on this unit worth preserving (app-only keeps it; merged image would erase)?
- Is this port (`usbmodem1101`) definitely the Stopwatch, and is it the only board attached?
- Which interface for demo ask: CLI `agent-dial ask` vs socket JSON.
- Timeline: generating Day 35 firmware is the critical path; fallback is the terminal prompt (PLAN slot "Approve").
