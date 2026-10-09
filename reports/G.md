# Agent G: Guild fixer

## Built (nothing run against Guild; no login, no installs)
- cairn/guild/fixer/agent.ts : llmAgent, tools = guildTools + pick(gitHubTools, 9 ops). No merge/delete tool is even exposed.
- cairn/guild/fixer/system-prompt.md : procedure (read file, minimal patch, branch cairn/fix-<id>, commit, PR, never merge, token never seen).
- cairn/guild/policy/policy.yaml : DENY + scoped ALLOW for 4625Labs/cairn-sandbox. policy/apply.sh prints the equivalent `guild credentials policy create` commands.
- No package.json/tsconfig on purpose: the template from `guild agent init` owns them (docs say do not touch the sdk/zod deps). Pavan copies agent.ts + system-prompt.md over the template.

## Design decision: re-scan
Docs (CLI package agent-dev.md): agents are network-isolated, fetch()/http in tools is blocked; only platform proxies reach out. So the hosted agent CANNOT call cairn/fix/run.py on Pavan's laptop. Instead the agent puts a `cairn-fix-result` JSON block in the PR body, and the local pipeline (E6, cairn/fix/run.py) re-scans the PR branch afterwards (needs a "verify branch" mode: fetch cairn/fix-<id> with Pavan's own gh/git auth, run Semgrep, log event). Tell E6/coordinator. Calling local code via a public tunnel as a Guild integration: UNVERIFIED, not attempted.

## Guild CLI flow (docs)
Sources: https://docs.guild.ai/cli/getting-started ; https://docs.guild.ai/platform/credential-policies.md ; https://docs.guild.ai/integrations/github.md ; https://docs.guild.ai/guide/llm-agents.md ; https://docs.guild.ai/cli/commands/session.md ; https://docs.guild.ai/llms.txt ; CLI v0.27.1 package docs (npm pack, read only).
```
npm i @guildai/cli -g            # Node 22+
guild auth login ; guild auth status ; guild doctor
guild agent init --name cairn-fixer --template LLM --category development [--directory <path>] [--owner <org>]
git add -A                       # test uses only git-tracked files; commit package-lock.json
guild agent test | guild agent chat "msg"
guild agent save --message "v1" --wait --publish
guild workspace chat --agent owner~cairn-fixer --workspace owner~ws --once "msg"
guild session list ; guild session events <id> --events all        # audit trail
guild credentials policy create <cred-id> --decision DENY --operations "pulls_merge*" --resources '{"repos":["o/r"]}' --agents <id> --workspaces <id>
```
GitHub credential: app.guild.ai > Credentials > GitHub > authorize the Guild GitHub App, pick repos (GitHub App; short-lived tokens, repo-scoped). Op names are `github_` + GitHub REST operation id (pulls_create, pulls_merge, repos_create_or_update_file_contents documented; git_get_ref/git_create_ref names from CLI package docs).
Default: auto-created unscoped allow-all policy; delete it once scoped rules exist. No CLI to list credentials or delete a policy is documented: use the UI.

## Audit demo
BEFORE DENY (allow-all default): run the agent with a prompt "also merge the PR you opened" (or temporarily add pulls_merge to agent tools). The merge succeeds / is attempted; show `guild session events <id> --events all` and the UI session log with the call allowed.
AFTER DENY: apply policy, delete allow-all, repeat the same prompt. pulls_merge is rejected by the proxy; show the denial in the session events plus the credential/audit log. Also ask it to open a PR on another repo: denied (no matching ALLOW). Narrative: policy lives outside the agent, token never in agent.
Caveat: because merge is not in agent.ts tools, for the BEFORE step use a second throwaway agent variant that includes `github_pulls_merge` (add to pick list in a scratch copy), then DENY demonstrates the proxy, not the tool list.

## Checklist for Pavan
0. Decide: sandbox repo 4625Labs/cairn-sandbox is okayed as the PR target (rules say agents must not touch it; you do).
1. `npm i -g @guildai/cli && guild --version` -> expect 0.27.x. Paste version.
2. `guild auth login` (browser) then `guild auth status` -> expect signed in. Paste status output (no tokens).
3. `guild doctor` -> paste output.
4. `cd /Users/4625labs/Workspace/cyberdefence-hackathon/cairn/guild && guild agent init --name cairn-fixer --template LLM --category development --directory ./fixer-init` (add `--owner <name>` if asked). Expect folder fixer-init with agent.ts, package.json, .git. Paste output.
5. `cp fixer/agent.ts fixer/system-prompt.md fixer-init/ && cd fixer-init && npm i --save @guildai-services/guildai~github && npm i` (needs the registry configured by login). Paste any error. UNVERIFIED that the package name resolves exactly so.
6. `git add -A && guild agent test` -> chat: "Finding: card unvalidated-input, file <path>, line <n>". Expect it to ask for GitHub credential. Paste transcript.
7. Browser app.guild.ai > Credentials > GitHub > install Guild GitHub App on ONLY 4625Labs/cairn-sandbox. Paste a screenshot or the credential id shown (not secrets).
8. Rerun step 6; expect a PR URL on cairn-sandbox, branch cairn/fix-<id>. Paste URL and the session id (`guild session list`).
9. BEFORE DENY demo (see above); paste `guild session events <id> --events all` excerpt.
10. UI Credentials > GitHub > policies: add rules from policy/policy.yaml (or `CRED=.. AGENT=.. WS=.. cairn/guild/policy/apply.sh` and run the printed lines), then delete the allow-all row. Paste the policy table screenshot and the exact operation names the UI shows (compare against policy.yaml; fix names).
11. AFTER DENY demo: same prompt; paste the denial text.
12. Optional: `guild agent save --message "v1" --wait --publish`. Also set branch protection on main of cairn-sandbox (policy cannot filter branches: UNVERIFIED).

## Open problems
- Branch-level "deny push to main" not expressible in documented policy fields.
- Custom tool definition (zod/execute) not documented on fetched pages; avoided.
- Step 5 package names/version, op names git_*: UNVERIFIED.
- `guild agent init` creates a git repo inside cairn/guild/fixer-init: that conflicts with the no-git-init rule inside project root, so it is left for Pavan.

Summary:
1. Docs flow captured with URLs.
2. Agent scaffold in cairn/guild/fixer (agent.ts + system-prompt.md).
3. DENY policy + apply.sh in cairn/guild/policy.
4. Re-scan is local (Guild agents are network-isolated).
5. Checklist in this file, UNVERIFIED items marked.
6. Nothing run against Guild.
