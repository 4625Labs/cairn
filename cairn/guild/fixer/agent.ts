// Cairn fixer: Guild-hosted LLM agent.
// Takes a Cairn finding, proposes a MINIMAL patch, opens a PR on 4625Labs/cairn-sandbox.
// It never sees a GitHub token: Guild's credential proxy injects it server-side after a policy check.
// Re-scan is NOT done here (Guild agents are network-isolated and cannot reach localhost);
// Cairn's local pipeline (cairn/fix/run.py) re-scans the PR branch afterwards.
import { guildTools, llmAgent, pick } from "@guildai/agents-sdk"
import { gitHubTools } from "@guildai-services/guildai~github"
import systemPrompt from "./system-prompt.md"

export default llmAgent({
  description: "Cairn fixer: minimal security patch + PR on the sandbox repo.",
  systemPrompt,
  tools: {
    ...guildTools, // lets the agent request the GitHub credential (proxy-held, never exposed)
    // Least privilege: only what a fix PR needs. No pulls_merge, no delete ops are even offered.
    ...pick(gitHubTools, [
      "github_repos_get",
      "github_repos_get_content",
      "github_git_get_ref",
      "github_git_create_ref",
      "github_repos_create_or_update_file_contents",
      "github_pulls_create",
      "github_pulls_get",
      "github_pulls_list_files",
      "github_issues_create_comment",
    ]),
  },
})
