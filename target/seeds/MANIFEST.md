# Seed manifest

Origin repo: /Users/4625labs/Workspace/pet-projects/esptember at HEAD 2ea26363 (read-only; not modified).
All line numbers below were checked with grep against the files in this folder.
Paths are relative to target/seeds/.

## Seeds and cousins: unvalidated input

| File | Origin | Bug present (file:line) |
|---|---|---|
| drafts/chan-live-captions/firmware/main/portal.c | `git show HEAD:` version (vulnerable) | SEED: scanned SSID pasted into HTML unescaped, 111-115 (`<option>%.32s</option>`). Cousins: form body read once, no length or return checks, 146-150; `url_decode` uses `strtol` with no hex check, 128-135, called at 151-152; open AP `WIFI_AUTH_OPEN`, 184 |
| drafts/chan-live-captions/firmware/main/portal.fixed.c | working tree (uncommitted fix, not by us) | Reference only. `html_escape()` at 94, used at 143-145 |
| drafts/chan-live-captions/firmware/main/portal.h | HEAD (unchanged) | header needed by portal.c / main.c |
| drafts/chan-live-captions/firmware/main/auth.h | HEAD | server link shown as QR with no scheme/domain check, 85-88; double cast `(int64_t)exp->valuedouble`, 51 |
| drafts/chan-live-captions/firmware/main/main.c | HEAD | `lv_qrcode_update(qr,uri,strlen(uri))`, 47; `(uint64_t)seq->valuedouble`, 129 (note: line 129 does check types first) |
| days/day-34-pi-pet/kept-build/host/pi-pet/hub.mjs | HEAD | only JSON.parse guarded, `msg.id` 340 (throws on `null`), `path.basename(msg.cwd)` 342 (throws on non-string cwd); `raw` passthrough 345; `msg.seconds` 351 |
| days/day-34-pi-pet/kept-build/device/pi_pet/pi_pet.ino | HEAD | `rec` sscanf, only `st > 0` checked, 1469-1473; `atoi(...) % count` 1479, 1480 |
| days/day-34-pi-pet/kept-build/device/pi_pet/net_link.h | HEAD | `uint16_t(atoi(pt))` port, 136, 141, 151, 153, 155 |

portal.c and portal.fixed.c are listed side by side so the demo can diff them.
Note: main.c includes headers not copied (board.h, display.h, caption_text.h, capture.h). This is a scan target, not a buildable project.

## Seeds and cousins: unpinned dependencies

| File | Bug present (file:line) |
|---|---|
| days/day-01-hello-world/firmware/main/idf_component.yml | `esp_io_expander_tca9554: "*"` line 3; `^2.0.3` line 2 |
| days/day-02-styled-text/firmware/main/idf_component.yml | `"*"` line 3; `^2.0.3` line 2 |
| days/day-03-static-graphic/firmware/main/idf_component.yml | `"*"` line 3 (while lines 2 and 4 are pinned with `==`, a good contrast) |
| drafts/chan-live-captions/firmware/main/idf_component.yml | `"*"` line 3; `^2.0.3` line 2; `esp_websocket_client: "^1.2.3"` line 4 |
| days/day-34-pi-pet/kept-build/host/pi-pet/package.json | `"serialport": "^13.0.0"` line 5 |
| days/day-34-pi-pet/kept-build/host/pi-pet/package-lock.json | `resolved` URLs on host socket-firewall.workos.dev (21 per recon; first at line 14); `hasInstallScript: true` line 29 |

Not copied: days 04-06 manifests (same `"*"`), pnpm-lock.yaml, site package.json.
