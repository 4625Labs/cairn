# Recon report: esptember (read-only), unvalidated input + risky dependencies

Repo: /Users/4625labs/Workspace/pet-projects/esptember (HEAD 2ea26363). Nothing in it was modified. Semgrep is NOT installed (`which semgrep` empty), so everything below is manual reading.

## Headline facts (read these first)

1. Day 35 Agent Dial has NO host or firmware source in the repo. It is a prompt/spec/tests lesson. `days/day-35-agent-dial/` holds only SPEC.md, README.md and `tests/` (check_host.mjs, check_device.py, reference_model.py, ...). The hub (`hub.mjs`, `lib/frame.mjs`) is generated into an ignored `.build/` folder that does not exist. Days 22, 23, 27, 31, 32 and 33 are the same: specs and contract.json only, no .c/.ino/.mjs.
2. The REAL code that matches Day 35's design is its direct ancestor, Day 34 Pi Pet: `days/day-34-pi-pet/kept-build/` (hub.mjs 404 lines, pi_pet.ino 1597, net_link.h 307, index.ts 166). Day 35's README says its hub reuses the same socket/serial/redaction design, so Day 34 is the best stand-in for "the hub".
3. The other real C code is in `drafts/chan-live-captions/firmware/main/` (portal.c, main.c, auth.h, caption_text.h) and `drafts/grok-bot/`.
4. portal.c has an UNCOMMITTED edit in the working tree (`git status` shows ` M`). HEAD contains the vulnerable version, the working tree contains a fix (see R-01). The "seed bug" exists as git history, not in the current file.
5. Site (Astro) is clean of injection sinks: no `set:html`, no `innerHTML`, no `fetch`.

Plain-English meaning of "unvalidated input" here: text arrives from somewhere we do not control (a radio, a socket, a serial line, a JSON message, a front-matter field) and is used without checking its type, size, or characters.

---

## Ranked findings

### R-01 (UNVALIDATED INPUT, confirmed, STRONG SEED) rogue Wi-Fi name pasted into HTML unescaped
- File: `drafts/chan-live-captions/firmware/main/portal.c`, lines 111-115 at HEAD (the working tree has since fixed it, lines ~140-146).
- Snippet at HEAD:
  ```c
  char option[80];
  for (int i = 0; i < n; i++) {
      snprintf(option, sizeof(option), "<option>%.32s</option>", (const char *)aps[i].ssid);
      httpd_resp_sendstr_chunk(req, option);
  ```
- Why it is a problem: the list of network names comes from whatever radios are nearby. Anyone can broadcast a network called `</option><script>...`. The setup page prints it straight into the page the owner types their Wi-Fi password into. The author already knew: the new working-tree comment says "a rogue SSID is an easy stored-XSS vector here".
- Fix in working tree adds `html_escape()` plus a `Content-Security-Policy` header. Good demo: the fixed and unfixed versions are both available.
- Confidence: confirmed (diff read with `git diff`). Seed: YES, the best one. Use `git show HEAD:...portal.c` to plant it in `target/`.

### R-02 (UNVALIDATED INPUT, confirmed, STRONG SEED) captive-portal form body parsed with no length or content checks
- File: `portal.c`, HEAD lines 145-151 (working tree lines 175-182).
- Snippet:
  ```c
  char body[192] = {0};
  const int len = httpd_req_recv(req, body, sizeof(body) - 1);
  if (len <= 0) return ESP_FAIL;
  char ssid[33] = {0}, pass[65] = {0};
  httpd_query_key_value(body, "ssid", ssid, sizeof(ssid));
  httpd_query_key_value(body, "pass", pass, sizeof(pass));
  url_decode(ssid); url_decode(pass);
  ```
- Why it is a problem (several small ones, all real):
  - One `recv` call: a body longer than 191 bytes, or split across packets, is silently cut. A long password is stored truncated, and the user is told "Saved".
  - Return values of `httpd_query_key_value` are ignored, so a too-long or missing value is not rejected.
  - Wi-Fi names are limited to 32 raw bytes, but the check is on the URL-encoded text. A 20-character name with spaces/symbols can exceed 32 encoded bytes and get cut BEFORE decoding.
  - `url_decode` (lines 158-171) uses `strtol(hex)` with no hex check. `%zz` decodes to byte 0, which ends the string early. `%00` does the same on purpose.
  - Empty SSID is accepted and saved (`main.c:269 portal_save_creds`), and `portal_save_creds` uses `ESP_ERROR_CHECK`, so a bad NVS write reboots the device.
  - No sign the request is from the owner: open AP (`WIFI_AUTH_OPEN`, portal.c:214), any of 4 clients can POST `/save`.
- Confidence: confirmed (read the code). Seed: YES (a classic "form text, no check" shape).

### R-03 (UNVALIDATED INPUT, confirmed by reading, STRONG SEED) hub crashes on a bad message
- File: `days/day-34-pi-pet/kept-build/host/pi-pet/hub.mjs`, lines 338-342 (and 332-367 overall).
- Snippet:
  ```js
  try { msg = JSON.parse(text); } catch { continue; }
  const id = msg.id ? shortId(msg.id) : null;
  switch (msg.t) {
    case "hello": owned.add(id); upsert(id, { name: msg.name || path.basename(msg.cwd || "") || "pi" }, sock); break;
  ```
- Why it is a problem: only `JSON.parse` is guarded. Any one-line message of `null` makes `msg.id` throw. A `hello` whose `cwd` is a number or object makes `path.basename()` throw. Nothing catches it, so the whole hub process dies and every session loses its dial. The message shape (type of `id`, `name`, `cwd`) is never checked.
- Day 35's SPEC (lines 140-210) uses the same newline-JSON socket and says "bad ids are ignored" and caps fields. The Day 35 test (check_host.mjs:93) tests a bad id but not a `null` or wrong-type message. The Day 35 code itself is not in the repo, so we cannot say it has this bug; we can say Day 34's does.
- Confidence: confirmed by reading; not run (would need node + serialport install, not allowed in that repo). Seed: YES, and it is the closest match to the Day 35 hub.
- Cousins in the same file: R-04, R-05, R-06.

### R-04 (UNVALIDATED INPUT, likely) any local client can send raw commands to the device
- File: hub.mjs:345. `case "raw": writeDevice(clean(msg.line, 120)); break;`
- `clean()` (line 44) only strips non-printable characters and caps length. So any process that can open the hub socket can send `forget`, `wifi ...`, `pair ...`, `reset` text to the board over USB. The socket is created with default permissions (hub.mjs:384-385, `mkdirSync(HUB_DIR)` with no mode), so on a shared machine other users may reach it.
- Confidence: likely (socket file mode not tested). Seed: good second example of "text from a client trusted too much".

### R-05 (UNVALIDATED INPUT, likely) USB hello fields trusted as-is
- File: hub.mjs:128-144 and 146-150. `link.deviceId = fields.id;` then `devices[fields.id] = rec;` and later `pi-pet-${id.slice(8)}.local` (line 221) as a dial host.
- The Wi-Fi path checks the id with a strict regex (hub.mjs:246, `^HELLO ([0-9a-f]{12}) ([0-9a-f]{16})$`), the USB path does not. Any device with the Espressif vendor id 303a is auto-opened (line 174) and its `id=` is written into `devices.json` and used to build a hostname.
- Confidence: likely. Seed: yes, a "validated here, not validated there" pair.

### R-06 (UNVALIDATED INPUT, confirmed small) `pause` and shortId edge cases
- hub.mjs:351 `Math.min(Number(msg.seconds) || 300, 3600)`: a negative number is accepted (becomes "already expired"). Minor.
- hub.mjs:45 `shortId` keeps the last 8 letters/digits, so two different session ids can map to the same pet and overwrite each other. Minor.
- Confidence: confirmed. Seed: no, use as filler cousins only.

### R-07 (UNVALIDATED INPUT, confirmed, SEED) device "rec" command: unchecked numbers drive a memory allocation and reads
- File: `days/day-34-pi-pet/kept-build/device/pi_pet/pi_pet.ino`, lines 1466-1475 (reads at 1396-1404).
- Snippet:
  ```c
  int n2, x0, y0, sz, st;
  if (sscanf(line + 4, "%d %d %d %d %d", &n2, &x0, &y0, &sz, &st) == 5 && st > 0) {
    free(recBuf); free(recT);
    recOut = sz / st; recN = n2; ...
    recBuf = static_cast<uint16_t *>(ps_malloc(size_t(n2) * recOut * recOut * 2));
    recT = static_cast<uint32_t *>(ps_malloc(n2 * 4));
  ...
  const uint16_t *row = fb + (recY + y * recStep) * W + recX;
  for (...) dst[y * recOut + x] = row[x * recStep];
  ```
- Why it is a problem: only `st > 0` is checked. A negative frame count wraps to a huge size; no range for `x0`, `y0`, `sz` means the capture loop reads outside the screen buffer; the second allocation is not checked for failure before `recT[recI++]` is written. The command is also reachable from the authenticated Wi-Fi link, because `processLine(..., false)` only blocks provisioning commands (pi_pet.ino:1453-1457), not `rec`.
- It is a debug command, so impact is crash/odd reads, not remote takeover. Confidence: confirmed by reading; not run. Seed: YES (numbers from a text line used with no range).
- Cousins: pi_pet.ino:1479 `atoi(line + 5) % kExprCount` (negative stays negative, then used as an index), :1480 `atoi(line + 6) % kStyleCount`; net_link.h:136/141/153/155 `uint16_t(atoi(pt))` for the port (no 1-65535 check, "pair" accepts a non-hex 64-char token, net_link.h:133).

### R-08 (UNBOUNDED INPUT, likely) device accepts any LAN connection and stalls on it
- File: `kept-build/device/pi_pet/net_link.h`, lines 244-247 and 173-186, 191-213.
- Snippet: `WiFiClient incoming = server.accept(); ... if (!handshake(incoming)) continue;` with `readLine(client, line, sizeof(line), 3000)` (twice).
- One task handles one connection at a time and waits up to 3 s per read. Anyone on the LAN who opens the port and says nothing blocks the real hub from connecting. Also net_link.h:205 compares the HMAC with `strcmp` (not constant time) while the hub side correctly uses `crypto.timingSafeEqual` (hub.mjs:256). Small, but a clean "same check done two ways" pair.
- Confidence: likely. Seed: secondary.

### R-09 (UNVALIDATED INPUT, likely) numbers from the network cast to integers
- File: `drafts/chan-live-captions/firmware/main/main.c:129` `(uint64_t)seq->valuedouble!=last_sequence+1`, and `auth.h:51` `token_expires=(int64_t)exp->valuedouble;`.
- Converting a huge, negative or NaN double to an integer is undefined in C. The surrounding code is otherwise careful (it checks types with `cJSON_IsNumber`, caps text at 3000, and the message buffer at 8192, main.c:166). This is a "mostly validated, one gap" example.
- Confidence: speculative-low (needs a hostile server; both endpoints are TLS to the vendor's host).

### R-10 (UNVALIDATED INPUT, likely) server-supplied sign-in link shown as a QR code with no check
- File: `drafts/chan-live-captions/firmware/main/auth.h:85-88`. `verification_uri_complete` from the HTTP reply goes to `show_login(uc->valuestring, uri->valuestring)` then `lv_qrcode_update(qr,uri,strlen(uri))` (main.c:47). No check that it is `https://` or on the expected domain, no length cap on `user_code`, return value of the QR call ignored.
- Compare the care shown elsewhere (client id is pinned, auth.h:5, 100). Confidence: likely. Seed: secondary.

### R-11 (UNVALIDATED INPUT, confirmed, low) site front matter used raw
- `src/lib/youtube.ts:6` `return m?.[1] ?? input;` falls back to the raw string; `FeaturedVideo.astro:9` puts it into an iframe `src`. `src/content.config.ts:16` `video: z.string().optional()`, `firmware: z.string().optional()` have no pattern or length, and `firmware` flows to `Lesson.astro:57` `href=` and `manifest.json.ts:23`.
- Input is the author's own front matter, so real risk is low. Useful as a TS-flavored cousin of R-03 ("string accepted, never checked").
- Cousin with the same shape: the Astro schema `z.string()` for title/summary/verification/toolchain.

### R-12 (DESIGN WEAKNESS, confirmed, documented by the author) Day 35 Wi-Fi bearer token not encrypted
- `days/day-35-agent-dial/SPEC.md:134` "traffic is authenticated but not encrypted. Anyone on the network who captures a request learns the token". Plain HTTP on port 47838 with a static token (SPEC:124-127). The author lists it under Roadmap. Not code; spec only.
- Seed: no (already known). Worth citing as the contrast with Day 34's HMAC handshake.

---

## (a) Top 3 candidate seed bugs for the "unvalidated-network-input" card, each with cousins

1. **Rogue Wi-Fi name into HTML (R-01)** — seed: `portal.c` HEAD:111-115.
   Cousins: R-02 `portal.c` body parse (HEAD 145-151) and `url_decode` (158-171); `auth.h:88` / `main.c:47` server link into a QR (R-10); `main.c:159-161` prints transport text from the socket (guarded by prefix + length, a "good" contrast).
   Why best: real, both vulnerable and fixed versions exist, plain-English story ("text from a radio you do not control was pasted into a page"). The fix is already in the working tree, so the "reintroduce the bug" step of the demo is a one-line revert.
2. **Hub trusts message shape (R-03)** — seed: `hub.mjs:338-342`.
   Cousins: hub.mjs:345 (`raw`), hub.mjs:128-144 (USB hello id), hub.mjs:351 (`pause`), plus the Day 35 test `check_host.mjs:93-97` that exercises the same entry point. Closest to the Day 35 story (the device the demo uses).
3. **Device "rec"/atoi numbers (R-07)** — seed: `pi_pet.ino:1466-1475`.
   Cousins: pi_pet.ino:1479-1480 (`atoi % count`), `net_link.h:136,141,153,155` (port via atoi), `net_link.h:133` (token length but not hex).
   Caveat: the number-parsing family is in C++ firmware, so Semgrep needs a C/C++ rule; the JS ones (option 2) are easier for a quick rule.

Note for the demo: if the Cairn sweep is meant to produce "one seed plus cousins" with one rule, option 1 or 2 gives 3+ hits that a single plain-English card ("text from outside is used without a type, length or character check") would cover; option 1 mixes C and HTML but all three share the same cause.

## (b) Top dependency findings

| id | file:line | snippet | issue | confidence |
|---|---|---|---|---|
| D-01 | `days/day-01-hello-world/firmware/main/idf_component.yml:3`; also day-02, day-03..06; `drafts/chan-live-captions/firmware/main/idf_component.yml:3` | `espressif/esp_io_expander_tca9554: "*"` | Wildcard: any future release is pulled in on the next build. Present in 8 manifests (days 01-06 and the draft). | confirmed. Seed: YES (best one) |
| D-02 | `days/day-01-hello-world/.../idf_component.yml:2` and day-02; draft `:2` | `waveshare/esp32_s3_touch_amoled_1_8: "^2.0.3"` | Caret range on a board-support package (days 03-06 pin `"==2.0.3"`, so the repo is inconsistent, a good "cousin" story). | confirmed |
| D-03 | `drafts/chan-live-captions/firmware/main/idf_component.yml:4` | `espressif/esp_websocket_client: "^1.2.3"` | Caret on the library that carries the sign-in bearer token. It resolved to 1.8.0 in the lock. | confirmed |
| D-04 | `days/day-34-pi-pet/kept-build/host/pi-pet/package-lock.json` (21 `resolved` lines) | `"resolved": "https://socket-firewall.workos.dev/@serialport/..."` | The lockfile points every package at a proxy host, not the npm registry. Anyone installing from it trusts that host (integrity hashes are present, which limits the risk). Also `@serialport/bindings-cpp` `hasInstallScript: true` (line 29), meaning a native build runs on install. | confirmed (read); risk level: moderate |
| D-05 | `.../host/pi-pet/package.json:5` | `"serialport": "^13.0.0"` | Caret range; the lockfile pins the real version, so only a risk if someone runs without it. Day 35's host reuses this pattern (Day 35 README names `serialport` host code but ships no package.json). | confirmed |
| D-06 | `package.json:9-10,13` (site) | `"astro": "^5.13.0"`, `"esp-web-tools": "^10.4.0"`, `"wrangler": "^4.33.0"` | Caret ranges; `pnpm-lock.yaml` pins astro 5.18.2, esp-web-tools 10.4.0, vite 6.4.3, esbuild 0.25.12/0.27.7/0.28.1, undici 7.29.0/8.10.1, so the lock is the real guard. Lockfile has no git/tarball/link sources (checked). Three esbuild and two undici majors co-exist. | confirmed |
| D-07 | `src/components/Lesson.astro:80` | `import "esp-web-tools/dist/web/install-button.js";` | A browser-side library that talks to USB/serial on the visitor's machine and installs firmware from the site's own manifest. Worth an audit more than a version bump. No CSP or other security header in `public/_headers` (it only sets two Content-Types). | confirmed; low-moderate |
| D-08 | `.agents/skills/grok-bot-esp32/...` | not examined for dependencies | Skill files, not shipped code. | not checked |

Good-news items (so the card does not over-claim): `days/day-03..06` pin `lvgl/lvgl: "==9.5.0"`; the draft has a real `dependencies.lock` with component hashes (every dependency is a fixed version with a hash); the pnpm lockfile has integrity entries; no `curl | sh` installs or unpinned git refs were found in any manifest.

Cleanest seed for the "risky dependency" card: D-01 with D-02/D-03 as cousins, 8+ locations, one-line fix (`"*"` -> `"==2.0.3"`, the exact version already in the lock).

## (c) Not verified / not found

- Semgrep not installed, so no automated scan was run. Everything here is manual reading.
- Day 35 hub/firmware source: not in the repo, so Day 35 itself cannot be called vulnerable. R-03/R-04/R-05 are in Day 34's hub, the nearest real code. If the demo needs Day 35 code, it has to be generated from the prompt (needs a build run, outside Recon scope).
- Days 22, 23, 27, 31, 32, 33: specs only. They state the right rules ("bound HTML bodies, request sizes", "validate persisted length...", "redact tokens"), which is useful as the "rule the team meant" half of a card, but there is no code to scan. None found in those days.
- Nothing was executed. R-03 and R-07 were confirmed by reading only (running needs `npm install serialport` or a flash, both out of bounds).
- `pnpm audit` / known-CVE lookup for astro 5.18.2, esp-web-tools 10.4.0, serialport 13 was NOT done (needs network and a package manager). Component CVEs (esp_websocket_client 1.8.0, lvgl 9.6.0) also unchecked.
- `public/_headers` sets only Content-Type; whether Cloudflare adds security headers at the edge is unknown.
- Whether the Day 34 hub socket is world-reachable (R-04) depends on the machine's umask; not tested.
- The ` M portal.c` working-tree change is uncommitted and not by us. Treat HEAD as the source of the seed and tell Pavan before relying on it.
