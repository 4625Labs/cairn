#!/usr/bin/env bash
# Prints (does not run) the guild CLI commands equivalent to policy.yaml.
# Fill the ids from the UI (Credentials page) or `guild agent get`, then run each line yourself.
CRED="${CRED:?github credential id}"; AGENT="${AGENT:?agent id}"; WS="${WS:?workspace id}"
cat <<CMDS
guild credentials policy create $CRED --decision DENY --operations "pulls_merge*,repos_delete*,*_delete*,git_delete_ref,repos_update*,git_update_ref" --agents $AGENT --workspaces $WS
guild credentials policy create $CRED --decision ALLOW --operations "repos_get,repos_get_content,git_get_ref,git_create_ref,repos_create_or_update_file_contents,pulls_create,pulls_get,pulls_list_files,issues_create_comment" --resources '{"repos":["4625Labs/cairn-sandbox"]}' --agents $AGENT --workspaces $WS
# then delete the allow-all policy in the UI (no CLI delete documented: UNVERIFIED)
CMDS
