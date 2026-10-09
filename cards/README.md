# Cairn cards

A card is a short Markdown file that describes one recurring kind of mistake in plain English.
It is written from one real bug (the seed) and is meant to be reused to find its cousins.
- File name is the card id, e.g. `unpinned-dependency.md`.
- Front matter: `id`, `class`, `severity`, `status`, `created`, `seed` (file:line).
- `status` starts as `draft`; a human promotes it after the cousins are checked.
- Behavior: what the code does wrong, language-neutral, not a regex.
- Why it matters: the harm in one or two sentences.
- How to recognize it: 3-5 signals a reader or tool can look for.
- Known copies: file:line list found so far. Mark each as confirmed or speculative.
- Safe pattern: what good looks like.
- Verification: how to re-check after a fix, including a Semgrep hint.
- Every claim must come from code that was actually read; guesses are labelled SPECULATIVE.
- Semgrep was not installed during recon, so the rule hints are untested.
- Keep each card under about 80 lines.
