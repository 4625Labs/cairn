# Sponsors report (Agent C), 2026-10-09

Method: official docs fetched, local read-only checks. Nothing installed, signed into, or sent.

## Local environment (verified)
- Present: docker 28.5.1, node v26.10.0, npm, python3 3.10.11, pip3, uv, curl.
- MISSING: semgrep, clickhouse, akash, pnpm, pi, guild.
- Guild CLI needs Node 22+ (ok, node 26).

---
## 1. Semgrep (Guardian)
Sources: https://docs.semgrep.dev/semgrep-guardian/quickstart , .../ide-setup/claude-code.md , .../rules-and-configuration , https://docs.semgrep.dev/llms.txt

Two plugins:
- Remote (recommended, default): `claude plugin install semgrep@claude-plugins-official`, then start `claude`; a browser OAuth sign-in prompt appears once. No local semgrep needed. Uses fixed ruleset `guardian-default` (based on `p/default`, only rules with a reliable autofix/sanitizer; code, supply chain, secrets). Not configurable; org Policies are NOT applied.
- Local: install the Semgrep CLI (https://docs.semgrep.dev/semgrep-guardian/install-cli.md), then in `claude`: `/plugin` -> Discover -> "Semgrep" -> Install -> `/reload-plugins`. Source repo `semgrep/guardian-local`. Uses your org Policies rules. (A search summary also mentioned `/plugin marketplace add semgrep/guardian`: UNVERIFIED.)
- Hook: docs say the plugin "registers a post-tool hook so Claude Code scans every file it writes". Exact event name (PostToolUse?) not stated in docs; the Semgrep GitHub reply cited in ideation.md says PostToolUse. Findings are returned to the agent after the file is on disk; agent may ignore them (non-blocking).
- Verify install: no documented step; check `/plugin` list in Claude Code. UNVERIFIED beyond that.
- Windows needs WSL (n/a, we are on macOS).

CLI scan to JSON (standard Semgrep; not on the Guardian pages, so UNVERIFIED against docs but well known):
```
python3 -m pip install --user semgrep     # or: uvx semgrep ; or: docker run --rm -v "$PWD:/src" semgrep/semgrep semgrep --config p/default --json /src
semgrep --config p/default --json --output findings.json target/
semgrep --config p/default --sarif target/ > out.sarif
```
Registry configs (`p/default`) need network but no login. `semgrep login` only needed for org Policies/Pro rules. For offline/deterministic demo use a local rule file: `semgrep --config cairn/rules/ --json target/`. Custom rules are the right way to encode the cards' seed bug.

- Time to first working call: remote plugin ~5 min (install + OAuth + write a file in a session). CLI scan via docker ~3-5 min (image pull).
- Biggest gotcha: `guardian-default` is fixed and only contains autofixable rules, so our planted "unvalidated input" bug may NOT trigger it. Plan on a custom local Semgrep rule for the seed bug and use Guardian as the live hook demo on a bug it is known to catch (e.g. hardcoded secret, vulnerable dep, classic injection). Test early. Also hook is non-blocking.
- Fallback: `docker run semgrep/semgrep` or `uvx semgrep` with local rules, run by Cairn after each agent write.
- Verdict: READY (account exists), with the rule-coverage caveat.

---
## 2. ClickHouse
Sources: https://clickhouse.com/docs/interfaces/http ; Cloud trial info from third-party pages (30 day, $300 credit; UNVERIFIED on official page; Cloud provision 2-3 min, UNVERIFIED).

User already has an account. Fastest: use existing Cloud service (copy host + password from console; HTTPS port 8443). If none exists, local docker works with no login:
```
docker run -d --name ch -p 8123:8123 -e CLICKHOUSE_USER=default -e CLICKHOUSE_PASSWORD=cairn -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 clickhouse/clickhouse-server:latest
```
(image pull ~1-2 min; the env var set is standard for the image but UNVERIFIED against docs here.)

Schema matching PLAN.md (append-only: never UPDATE/DELETE):
```
CREATE TABLE IF NOT EXISTS cairn_events (
  ts DateTime64(3) DEFAULT now64(3),
  kind LowCardinality(String),
  card_id LowCardinality(String),
  repo String, file String, line UInt32,
  actor String, tool String, detail String,
  verdict LowCardinality(String)
) ENGINE = MergeTree ORDER BY (card_id, ts);
```
Run DDL (HTTP, POST body, use --data-binary):
```
H='http://localhost:8123/'   # Cloud: https://<host>.clickhouse.cloud:8443/
echo "CREATE TABLE ... " | curl -sS -u default:cairn "$H" --data-binary @-
```
Insert:
```
echo '{"kind":"finding","card_id":"unvalidated-network-input","repo":"esptember","file":"day22/main.c","line":88,"actor":"semgrep","tool":"semgrep","detail":"strcpy from request","verdict":"confirmed"}' \
 | curl -sS -u default:cairn "$H?query=INSERT%20INTO%20cairn_events%20FORMAT%20JSONEachRow" --data-binary @-
```
Query ("is it one incident / spreading"):
```
SELECT card_id, uniqExact(file) files, count() n, min(ts) first, max(ts) last
FROM cairn_events WHERE ts > now() - INTERVAL 5 MINUTE GROUP BY card_id FORMAT JSON
```
Auth: Basic `-u`, or headers `X-ClickHouse-User`/`X-ClickHouse-Key` (documented). Always `--data-binary`, never `-d`.
- Time to first working call: ~5 min with existing Cloud service; ~5-8 min docker.
- Biggest gotcha: `DateTime64` ts in JSONEachRow needs a format ClickHouse parses (ISO or epoch); omit `ts` and let the DEFAULT fill it. Cloud: password shown once at service creation.
- Fallback: local SQLite with same columns (python sqlite3, stdlib).
- Verdict: READY.

---
## 3. Guild
Sources: https://docs.guild.ai/cli/getting-started , https://docs.guild.ai/platform/credential-policies.md , https://docs.guild.ai/platform/security-architecture.md

What it is: agent code runs in Guild's runtime, which holds no credentials or policy state; coding agents run in network-isolated containers whose only outbound paths are Guild proxies. A credential proxy injects service creds server-side after a policy check (creds never reach code, container, prompt, or state). LLM calls also go through a Guild proxy (model allowlist, daily token limit). GitHub uses a GitHub App minting short-lived installation tokens, scoped to repos where the App is installed. Session event log records LLM calls and tool invocations in real time; audit log is tamper-evident.

Commands (verified from docs):
```
npm i @guildai/cli -g
guild auth login        # browser sign-in at app.guild.ai
guild auth status ; guild doctor
guild agent init --name cairn-fixer --template LLM --category development   # run from parent dir
cd cairn-fixer          # edit agent.ts
git add -A              # only Git-tracked files are included in test! (folder must be a git repo; `init` creates it, do NOT push anywhere)
guild agent test        # interactive, or: guild agent chat "message"
guild agent save --message "v1" --wait --publish
guild workspace select
guild workspace chat --agent owner~agent-name --once "..."
guild setup             # installs coding-assistant skills (optional)
```
Templates: LLM (prompt + tool list; start here), AUTO_MANAGED_STATE (TS procedural), BLANK.

DENY rules (YAML, one key per credential; DENY beats ALLOW; fnmatch wildcards; omitted operations/resources = match all):
```yaml
github:
  - decision: DENY
    operations: [repos_delete, "*_delete", pulls_merge*, git_push_to_default*]   # exact op names UNVERIFIED, check UI table
  - decision: ALLOW
    operations: [pulls_create, pulls_get, issues_get, contents_*]
    resources: { repos: [owner/toy-repo] }
```
CLI: `guild credentials policy create <credential-id> --decision DENY --operations "pulls_merge*" --resources '{"repos":["owner/repo"]}' --agents <agent-id> --workspaces <workspace-id>`. Or UI credentials page (one row per operation, best way to get the real op names).
Default: every new credential gets an unscoped allow-all policy; unmatched requests stay allowed until you delete it. To get default-deny, add scoped rules then delete the allow-all. (Demo-worthy, matches ideation.)

- Time to first working call: ~10 min to `guild agent test` echo; 30-60 min for a fixer with GitHub credential (GitHub App install + credential connect in UI, UNVERIFIED steps).
- Biggest gotcha: `guild agent test` only sees git-tracked files (`git add`), and GitHub credential setup needs a GitHub App install on a repo, which means a repo exists on GitHub. Our rule: no pushing without Pavan's approval. A PR target repo must be a throwaway repo he okays; otherwise use the agent with no GitHub credential and have it output a patch.
- Fallback: local agent (Claude/Python) writes patch file into target/, Cairn prints PR description.
- Verdict: PARTIAL. CLI path clear; GitHub PR step needs Pavan's decision on a repo.

---
## 4. Akash
Sources: https://akash.network/docs/getting-started/quick-start/ , https://akash.network/docs/developers/deployment/akash-console/getting-started/ , https://akash.network/docs/getting-started/trial-deployment , SDL: https://akash.network/docs/developers/deployment/akash-sdl/

Docs disagree on credit: Console page says $100 trial credit with card; quick-start/trial page says $1, no card. Trial deployments auto-close after 24h, no high-end GPUs. Check your dashboard balance. Pay-as-you-go via card. Provider prices shown per month; a 0.5 CPU / 512Mi container is typically cents/month (specific price UNVERIFIED).

Minimal SDL (from official Quick Start; `denom: uact` per current docs, older docs use `uakt`):
```yaml
version: "2.0"
services:
  scanner:
    image: semgrep/semgrep:latest      # or your own public image; command: ["sh","-c","..."] allowed
    expose:
      - port: 80
        to: [{ global: true }]
profiles:
  compute:
    scanner:
      resources:
        cpu: { units: 0.5 }
        memory: { size: 512Mi }
        storage: { size: 512Mi }
  placement:
    akash:
      pricing:
        scanner: { denom: uact, amount: 100 }
deployment:
  scanner:
    akash: { profile: scanner, count: 1 }
```
Console steps (browser, no CLI needed): console.akash.network -> sign in -> Deploy -> paste/Upload SDL (or "Hello Akash" template, SDL Builder) -> request quotes -> pick provider -> "Confirm and deploy" -> dashboard shows URI -> Close deployment (unspent escrow returns). CLI route (akash CLI + funded wallet) is NOT recommended today; commands UNVERIFIED here.
- Time: under 30 min is realistic via Console (~10-15 min including bids; bid wait time not documented).
- Biggest gotcha: provider sees the manifest, so no secrets/target code with secrets in SDL; the container needs a PUBLIC image and must pull the code itself (or bake sample code into the image). Docker image must be pushed to a registry (Docker Hub) = a push, ask Pavan first; use an existing public image (semgrep/semgrep) with an inline command to avoid it.
- Fallback: same container in local Docker. Plan already says cut Akash first.
- Verdict: READY (account exists), low priority.

---
## 5. Pi
Sources: https://pi.dev/ ; https://glukhov.org/ai-devtools/pi/pi-coding-agent-review/ ; https://pi.dev/packages/pi-warden

- Pi = minimal open-source terminal coding-agent harness (package `@earendil-works/pi-coding-agent`; moved to Earendil Works May 2026). Install: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` or `curl -fsSL https://pi.dev/install.sh | sh` (do not run today unless wanted; piping curl to sh is not recommended).
- Four modes: interactive, print/JSON (`pi -p "query"`, `--mode json`), RPC over stdin/stdout (docs/rpc.md), SDK. Defaults: read/write/edit/bash tools. Project instructions via AGENTS.md; SYSTEM.md overrides system prompt. No built-in permission system, review feature, or sandbox. Extensions are TS modules; packages via `pi install npm:...`.
- NO public API or rule format for the "behavior description becomes review rule" loop. That loop is described only in the event material in ideation.md (UNVERIFIED publicly). Closest public thing: community extension `pi-warden` (judges each write against a `pi-warden.md` rules file); third party, not Pi's loop.
- Time to first call: ~5 min to install and `pi -p`, but not needed.
- Biggest gotcha: do not claim a Pi integration. Say "the Pi loop, built as files".
- Fallback / plan: behavior cards as markdown files in cards/ (already the plan). Optional bonus: card text used as an AGENTS.md / pi-warden.md-style rule for a Pi-driven fixer (UNVERIFIED feasibility; low priority).
- Verdict: NOT-APPLICABLE as an integration; READY as concept (cards-as-files).

---
## Summary table
| Sponsor | Verdict | To first call | Local fallback |
|---|---|---|---|
| Semgrep | READY (rule coverage caveat) | 5 min | docker/uvx semgrep + local rules |
| ClickHouse | READY | 5 min | docker clickhouse-server or SQLite |
| Guild | PARTIAL (needs repo decision for PR) | 10 min CLI, 30-60 min PR | local agent + patch file |
| Akash | READY, do last | 10-15 min Console | local docker |
| Pi | no public API, use cards-as-files | n/a | files |
