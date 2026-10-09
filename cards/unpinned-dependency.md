---
id: unpinned-dependency
class: supply-chain
severity: medium
status: draft
created: 2026-10-09
seed: target/seeds/days/day-03-static-graphic/firmware/main/idf_component.yml:3
---

## Behavior
A build manifest asks for a dependency with no real version limit, so the next build can silently
pull different code than the one that was tested. The seed is `espressif/esp_io_expander_tca9554: "*"`,
which accepts any release ever published. Looser cases are caret ranges (`^2.0.3`), and installs that
trust a non-standard download host written into a lockfile.

## Why it matters
A new release (honest bug or hijacked package) is built into the firmware or host tool without anyone
reviewing it. Builds stop being repeatable, so a bug cannot be reproduced later. In this repo some
neighbouring lines are already pinned, so the one unpinned line is easy to miss.

## How to recognize it
1. A version spec of `"*"`, `latest`, an empty version, or `>=` with no upper bound.
2. A caret or tilde range on a library that handles secrets, networking or hardware.
3. Mixed styles in one file (`==` on some lines, `*` on others).
4. A manifest with no matching lockfile, or a lockfile that lists a dependency not in the manifest.
5. Lockfile `resolved` URLs on a host that is not the official registry, or `hasInstallScript: true` on a package.

## Known copies
Seed and wildcard copies (confirmed, read):
- days/day-01-hello-world/firmware/main/idf_component.yml:3 `"*"`
- days/day-02-styled-text/firmware/main/idf_component.yml:3 `"*"`
- days/day-03-static-graphic/firmware/main/idf_component.yml:3 `"*"` (lines 2 and 4 use `==`)
- drafts/chan-live-captions/firmware/main/idf_component.yml:3 `"*"`
- Per recon, also days 04-06 (not copied here, UNVERIFIED by me).

Cousins (confirmed, read):
- day-01 and day-02 idf_component.yml:2 and the draft :2 `^2.0.3` (days 03-06 use `==2.0.3`).
- drafts/.../idf_component.yml:4 `esp_websocket_client: "^1.2.3"` (carries the sign-in token).
- host/pi-pet/package.json:5 `"serialport": "^13.0.0"` (the lockfile pins the real version).
- host/pi-pet/package-lock.json:14, 27 and others: `resolved` points at socket-firewall.workos.dev; line 29 `hasInstallScript: true`. Integrity hashes are present, which limits the risk. Whether that host is a trusted proxy is UNVERIFIED.

## Safe pattern
Pin an exact version (`"==2.0.3"`, `"1.8.0"`), commit the lockfile, install from it (`npm ci`), keep
the same pin style across files, and use the official registry or a documented mirror. Update
deliberately, in a change someone reads. The draft already has a `dependencies.lock` with hashes; the
`*` entry should be set to the version resolved there (check it before editing).

## Verification
- After the fix, no line in any `idf_component.yml` should match `"\*"`, and a rebuild should not change `dependencies.lock`.
- Quick check without Semgrep: `grep -rnE ':\s*"(\*|latest|\^|~)' --include=idf_component.yml --include=package.json .`
- Semgrep hint (UNTESTED, not installed): a generic-language rule with pattern `$NAME: "*"` limited to `paths.include: ["idf_component.yml"]`; JSON rules for `package.json` dependencies matching regex `^[\^~]`.
