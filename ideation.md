# Cyberdefense hackathon: questions to pick

Same-day build. Doors 9:30, kickoff 11:00, submit 4:30, demos 5:00 at the AWS Builder Loft. Judges include Pi (two engineers), Guild (Corbett), Akash (Greg Osuri), ClickHouse (Dustin Healy), and Semgrep (Daghan Altas, head of product). Speakers are the same companies. A demo that uses each product’s actual mechanism will read better than a logo slide.

What “use it” can mean before lunch, from the notes:

- **Semgrep Guardian** is installable today. The hook runs after the agent writes a file and pastes findings back. It does not block the write. The recommended plugin uses the fixed `guardian-default` ruleset, not your org’s policies.
- **ClickHouse** is the store for immutable security events and the sub-second question on top (“which services share this bug class in the last five minutes”). Do not update rows. Append events.
- **Guild** is the place the fixer agent runs. The agent holds no GitHub token. The proxy mints a short-lived token per call. New credentials start allow-all until someone writes a DENY. Software Factory’s rule is: the agent opens the PR, a person merges.
- **Akash** runs one container on one winning provider. The chain is only the ad and the escrow. The provider can see anything you put in the manifest, so secrets do not go in the SDL. Good job: an isolated scanner or replay sandbox.
- **Pi** has no public API or rule format in the notes. The published loop is the thing to build: one confirmed bug becomes a behavior description, that description finds cousins, and the description is saved as a review rule. Pi has the most people in the room (Guy Arazi speaking, two engineers judging).

Plant the bugs in a toy repo you control. The demo finds, explains, patches, and re-checks that repo.

## Start here if you want one project

**Can one loop close a vulnerability class before 4:30: find it, see how far it has spread, patch it without the agent holding keys, and catch the next copy?**

That single question is the four tracks in order:

1. Threat discovery. Semgrep confirms one bug. A Pi-style behavior card (plain text, not a regex) is pointed at the rest of the toy monorepo and returns the cousins.
2. Attack intelligence. Every finding, agent tool call, and “agent ignored the finding” is an immutable ClickHouse row. One query draws the class: where it lives, who introduced it, whether it is still spreading.
3. Autonomous remediation. A Guild agent opens a fix PR. The GitHub credential stays in the proxy. Guardian scans each file the agent writes and the agent rewrites on findings. A test, not a human speech, verifies the fix. A person still merges.
4. Continuous defense. The saved behavior card is the next session’s check. Reintroduce the bug and the hook fires again. The scanner container runs on an Akash lease so the untrusted replay is not on your laptop, and the lease dies when the escrow dies.

Demo script is four beats, one per track, under five minutes. If Akash or Guild credentials slip, the first three beats still stand and Akash is a live SDL plus a provider bid, not a silent dependency.

## Threat discovery

**When one confirmed bug exists, can we name the behavior and list every cousin in this repo before anyone writes an exploit?**
Semgrep is the confirmation. The behavior card is the Pi loop the AWS writeup describes (outbound request with no host allowlist, not a per-language regex). ClickHouse stores seed finding, candidates, and human confirm or reject. Demo: three planted copies in different files, one seed, two cousins returned. Pi’s judges are the audience.

**Which of these findings can actually be reached from the deployment we are about to lease?**
Semgrep finds the code bug. The Akash SDL says which port is public. The demo ranks a hardcoded secret in a private worker below the same bug in the service the SDL exposes. ClickHouse holds the ranking. This is the misconfiguration-plus-attack-path sentence on the Luma page, kept inside one toy app.

## Attack intelligence

**Three noisy alerts just fired. Are they one incident?**
Guild session events, Semgrep findings, and deploy events land in ClickHouse as append-only rows. One SQL groups them by behavior-card id and time window and answers yes or no with the evidence. Demo: a secrets write, a second copy of the same pattern, and a Guild tool call, collapsed into one row a person can read. ClickHouse’s judge wants the query, not a dashboard skin.

**What did the fixer agent do in this session, and which calls were only allowed because the credential defaulted to allow-all?**
Guild’s own security note: a new credential starts allowed. The demo connects a credential, shows the allow-all, and shows the audit of what the agent called before a DENY rule existed. ClickHouse is the count by agent, tool, and repo. Guild’s judge (Corbett) knows this default. Almost no team will say it out loud.

## Autonomous remediation

**Can the fixer patch the finding without the GitHub token ever entering the container, and can we prove the patch did not add a new bug?**
Guild proxy mints the token per call. Guardian’s post-write hook scans the new file. The agent rewrites if the hook returns a finding. A unit test verifies the fix. The PR is the artifact. This is the most buildable beat if the full loop is too much. Semgrep and Guild judges can both see their product.

**The hook cannot block the write. Can we still stop a bad patch from becoming the PR?**
Guardian’s docs and a Semgrep GitHub reply say `PostToolUse` runs after the file is on disk, and the agent may ignore the finding. The demo records “finding returned, agent kept the line” in ClickHouse, refuses to open the PR unless a second scan is clean, and shows the dirty file that almost shipped. Daghan Altas is head of product at Semgrep. This is the gap in their own notes.

## Continuous defense

**Tomorrow the same class comes back. Does the system notice and re-open the hunt with no one watching?**
The behavior card from the morning is re-injected as the check (the Pi “rule goes back into memory” sentence). A Guild schedule or webhook runs the scan. ClickHouse answers “did this class reappear since the fix.” Demo: a second commit reintroduces the bug, the row shows up, the agent opens a second PR. That is the whole continuous-defense claim.

**Can untrusted replay run on a rented machine that has no secrets, and shut itself off when the meter hits zero?**
Akash runs the scanner or replay container. SDL contains the image and the port, not a token. Guild holds the credential and only receives a pass or fail. Escrow-per-block is the kill switch. Demo: lease comes up, job finishes, lease closes. Greg Osuri is founder and judge. Do not put a customer secret in the manifest. The notes are explicit that the provider sees it.

## What to skip in a 5.5 hour room

- A new scanner, a new rules language, or a Pi integration that needs an API they have not published. Build the behavior card as a file.
- Anything that needs the agent to exploit a real target. The toy repo is the target.
- ClickHouse row updates, a Snowflake-shaped warehouse, or a multi-provider Akash cluster. One table, one lease, one provider.
- ElevenLabs, MongoDB, and OpenAI are also on the partner list. Leave them out unless a beat is already done and a judge asks.

## After you pick

Say which question (or the full loop). Next step is a build plan: toy repo, event schema, which sponsor call happens in which beat, and the order to cut if a credential is not ready at 11:00.
