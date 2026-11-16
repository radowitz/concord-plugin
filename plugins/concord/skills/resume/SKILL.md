---
name: resume
description: Resume a 贞观·政事堂 · Concord run in this session after a restart or interruption — reports stale in-progress steps as interrupted (never auto re-executed) and continues the /concord:run loop. Use only when the user invokes /concord:resume.
argument-hint: "[run-id|latest] [--retry] [--claude] [--retry-codex]"
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
     `H advance <run-id> --retry --one-step` as a background Bash task (see
     `${CLAUDE_PLUGIN_ROOT}/skills/run/SKILL.md`, helper stages). This re-runs exactly the failed step.
     A `failure.kind` of `timeout` was a helper time limit, not a verdict: mention `limits.review_timeout_s` / `extend`.
     If they don't, stop.
   - `implement`, `repair` or `continue`: carry on with the loop in section 2 of
     `${CLAUDE_PLUGIN_ROOT}/skills/run/SKILL.md`. Read it first if it isn't already in context.
   - `await_human` or `none`: summarise with `H status <run-id>` and stop.
   - `await_switch`: follow `${CLAUDE_PLUGIN_ROOT}/skills/takeover/SKILL.md` (the user decides; never you).
   - `paused`: report `pause` (kind, class, exact error, preserved files) and stop. Only on the user's explicit
     choice: `H resume <run-id> --claude` gives the pending step back to this session after a Claude limit reset
     (it also ends a Codex handoff), `H resume <run-id> --retry-codex` lets an approved Codex handoff run its
     incomplete writer step again with the same frozen model. Neither command runs anything by itself, and a
     paused run is never retried automatically.
   - `continue` with `owner: codex`: an approved Codex handoff owns the remaining coding. Run the stages
     (`H advance <run-id> --one-step` in the background); never implement the step natively or send `--done`.

If the helper answers `wrong_worktree`, rerun with the `--repo` it prints.

Before you re-do an `implement` step, check the working tree. A previous session may have
partly finished it. Never stash, reset or discard files to get a clean state; pre-existing uncommitted work in `baseline` belongs to the user.
