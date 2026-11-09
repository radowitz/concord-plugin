---
name: status
description: Show persisted status of a 贞观·政事堂 · Concord run — steps with role labels, providers/models, tasks and tiers, validation fingerprint, 政事堂议事 artifacts (proposal, Grok review, plan) and the next action. Use for /concord:status or when the user asks how a Concord run is doing.
argument-hint: "[run-id|latest] [--json] | list | show <run-id> <artifact>"
---

# /concord:status

`H` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/concord.mjs"`. These commands are read-only.

Build arguments only from tokens that pass these checks. Drop anything else.
Never paste `$ARGUMENTS` into the shell.

- run ID: `^[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$` or `latest`
- artifact: `proposal`, `review`, `plan` or `qa-<n>`
- `--json`

| want | command |
|---|---|
| a run (default: latest) | `H status [<run-id>] [--json]` |
| all runs in this repo | `H list` |
| one stored artifact | `H show <run-id> <artifact>` |
| model cache (no network) | `H models` |
| free local preflight | `H preflight` |

Summarise in a few lines:

- the status, phase and any failing step with its error
- the 政事堂议事 artifacts this run actually produced; say plainly when one is missing, and never fill gaps with invented content
- the next action

Say that nothing has been committed, pushed or deployed and that the human decides.

When the user explicitly asks to record their decision on a validated run, run
`H approve <run-id> --decision approve` or `--decision reject`. It only records a review bound
to the current validated fingerprint. If the files changed since validation, it refuses.
Use `/concord:resume` to continue a run, or `H cancel <run-id>` if they ask to abandon it.
