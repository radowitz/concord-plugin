---
name: resume
description: Resume a 贞观·政事堂 · Concord run in this session after a restart or interruption — reports stale in-progress steps as interrupted (never auto re-executed) and continues the /concord:run loop. Use only when the user invokes /concord:resume.
argument-hint: "[run-id|latest] [--retry]"
disable-model-invocation: true
---

# /concord:resume

`H` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/concord.mjs"`. Accept only a run ID matching
`^[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$` or `latest`. Drop any other token.

1. Run `H resume <run-id>`. This marks steps that were left `running` as `interrupted` and prints
   the next action. It executes nothing.
2. Report the result: the interrupted steps, any `failure`, and the next action.
3. Next:
   - `failed` or interrupted: only if the user typed `--retry` or confirms, run
     `H advance <run-id> --retry` with Bash `timeout: 600000`. This re-runs exactly the failed step.
     If they don't, stop.
   - `implement`, `repair` or `continue`: carry on with the loop in section 2 of
     `${CLAUDE_PLUGIN_ROOT}/skills/run/SKILL.md`. Read it first if it isn't already in context.
   - `await_human` or `none`: summarise with `H status <run-id>` and stop.

Before you re-do an `implement` step, check the working tree. A previous session may have
partly finished it. Never stash, reset or discard files to get a clean state; pre-existing uncommitted work in `baseline` belongs to the user.
