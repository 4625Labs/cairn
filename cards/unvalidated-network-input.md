---
id: unvalidated-network-input
class: input-validation
severity: high (seed) / medium to low (some copies)
status: draft
created: 2026-10-09
seed: target/seeds/drafts/chan-live-captions/firmware/main/portal.c:111-115
---

## Behavior
Text or numbers that arrive from outside the program (a nearby Wi-Fi radio, a web form, a socket
message, a serial line, a server reply) are used as if they were well formed. Their type, length,
range or characters are not checked before they are placed in a web page, parsed as a number, used
as a size or index, or handed to another component.

In the seed, the device scans for Wi-Fi networks and writes each network name straight into the
setup page's HTML. Anyone can broadcast a network whose name contains markup, and it runs in the page
where the owner types the Wi-Fi password.

## Why it matters
The attacker only needs to be nearby (radio), on the same network (socket) or to control a server
reply. Results range from a script running in the setup page, to a whole process crashing on one
bad message, to reads and allocations driven by a number the sender chose.

## How to recognize it
1. External text goes into `snprintf`/string concatenation that builds HTML with no escape step.
2. A parse call (`atoi`, `sscanf`, `strtol`, `JSON.parse`) has its result used without a range or type check.
3. Only the parse step is guarded (try/catch); the fields of the result are used freely.
4. Return values of key/value lookups are ignored, so missing or too-long values pass silently.
5. A value is checked in one entry path (Wi-Fi hello has a regex) but not in a sibling path (USB hello).

## Known copies
Seed (confirmed, read at HEAD):
- portal.c:111-115 SSID into `<option>` unescaped. The uncommitted working-tree version (portal.fixed.c:94,141-145) escapes it.

Cousins (confirmed by reading, none executed):
- portal.c:146-152 form body: single recv, `httpd_query_key_value` results ignored, then `url_decode`.
- portal.c:128-135 `url_decode`: `strtol` on two chars with no hex check; `%00` ends the string early.
- hub.mjs:340 `msg.id` throws if the message is `null`; hub.mjs:342 `path.basename(msg.cwd)` throws if cwd is not a string. Nothing catches it, so the hub process exits.
- hub.mjs:345 `raw` line forwarded to the device after only a length/printable filter.
- pi_pet.ino:1469-1473 `rec`: only `st > 0` is checked, then values drive `ps_malloc` and a read loop (the second allocation at 1473 is not checked).
- pi_pet.ino:1479, 1480 `atoi(...) % count` (negative stays negative).
- net_link.h:136, 141, 151, 153, 155 port from `atoi`, no 1-65535 check.
- auth.h:85-88 with main.c:47 server link shown as a QR code with no scheme or domain check (likely, needs a hostile server).
- auth.h:51 and main.c:129 double cast to integer (SPECULATIVE, low; type checks exist around it).

## Safe pattern
Check at the door: confirm the type, cap the length, allow only expected characters or a numeric
range, reject (do not truncate) on failure, and encode for the place the text lands (HTML-escape for
a page). Guard the whole message handler, not only the parse. Apply the same checks on every entry path.
The fixed portal.c is a working example (escape function plus a Content-Security-Policy header).

## Verification
- Reproduce: build the SSID `</option><script>x</script>` (or feed the hub a `null` line) and confirm the old behavior; then confirm the fix.
- Diff portal.c against portal.fixed.c; the cousins should show the same gap.
- Semgrep hint (UNTESTED, Semgrep not installed): C pattern `snprintf($B, $N, "...<...>%$S...", ...)` inside code that later calls `httpd_resp_send*`; JS pattern `path.basename($X.$F)` or `$MSG.$F` where `$MSG` came from `JSON.parse` without a type check; C pattern `atoi(...)` / `sscanf(...)` followed by `malloc`/index use.
