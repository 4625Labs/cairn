# Agent B report: cards and seeds

Built: target/seeds/ (14 files + MANIFEST.md), cards/unvalidated-network-input.md, cards/unpinned-dependency.md, cards/README.md.
- portal.c is the HEAD version (unescaped SSID at 111-115); portal.fixed.c is the working-tree fix. esptember untouched.
- Also copied portal.h (needed by portal.c/main.c), 3 `*` manifests (day-01, 02, 03) plus the draft manifest.
- Line numbers in MANIFEST.md were grep-verified. They differ from recon where recon cited working-tree lines (url_decode is 128-135 at HEAD, not 158-171).
Open: Semgrep not installed, so rule hints are untested. main.c includes headers not copied (not buildable). Days 04-06 "*" not verified by me.
Approval needed: none. Note the uncommitted portal.c edit in esptember is not ours.

Summary:
1. Seeds planted under target/seeds with MANIFEST.md.
2. portal.c is the vulnerable HEAD version; fixed copy beside it.
3. Cards: unvalidated-network-input, unpinned-dependency (draft).
4. cards/README.md written (16 lines).
5. All claims grounded in files read; speculation marked.
6. No tests or scans run.
