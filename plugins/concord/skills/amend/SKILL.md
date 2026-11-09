---
name: amend
description: Record a mid-run change to the goal of an ACTIVE 贞观·政事堂 · Concord run (new requirement, constraint or scope change from the user's latest message). Use only while a Concord run is open and the user's new message changes what that run must deliver. Not for status questions, discussion or a new unrelated task.
argument-hint: "[run-id|latest] <kind: clarify|scope> <text>"
---

# amend (Concord internal)

`H` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/concord.mjs"`. This skill is best-effort host behaviour: Claude Code supports
`UserPromptSubmit` hooks, but this plugin registers none, so a change only reaches the run when you notice it
and run this. Nothing is recorded automatically.

Use it when **all** hold: a Concord run is open (`H status latest --light` says `active`, `awaiting_session`,
`failed` or `validated`), and the user's new message changes what that run should deliver. Don't use it for
status questions, explanations, opinions about the diff, or a different task (that needs a new run).

1. Pick `kind`: `clarify` (same work, more detail or constraint) or `scope` (work added, removed or redirected).
   When unsure, ask the user once or choose `clarify`.
2. If an `implement`/`repair` step is pending, stop the native writer first (TaskStop the Agent, or wait for it).
   You may only pass `--writer-stopped` after that. If a helper stage is running, the amend is refused
   (`helper_busy`): either wait for the stage to finish, or run `H interrupt <run>` (kills that stage's process
   groups, records it as interrupted, keeps the run **open**; never `cancel`, which closes the run), then amend.
   Tell the user which you did.
3. Use the **Write tool** to create `/tmp/concord-amend-<8 random hex>.json`: `{"kind": "clarify", "text": "<the change in the user's words, self-contained>"}`.
   Never put the text in a shell command.
4. Run `H amend <run-id> --spec <file> [--writer-stopped]`. Work on from the returned next action: it carries
   the new `revision` and the effective `request`. Results you produced for an older revision are rejected;
   redo them against the new request. Edits already in the working tree are kept. After an `interrupt` the amend
   clears the interruption but runs nothing: continue with the loop only because the user wants the work to go
   on (a crash or timeout is never retried automatically). A `scope` amendment sends a full-policy run back
   through a Grok review of the revised request before re-planning.
5. Tell the user: the new revision, that validation was invalidated if it was, whether a re-plan happens, and
   that nothing was committed. Continue the loop in `${CLAUDE_PLUGIN_ROOT}/skills/run/SKILL.md`.

Run IDs match `^[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$` or `latest`. If the helper answers `wrong_worktree`, use the `--repo` it prints.
Details: `${CLAUDE_PLUGIN_ROOT}/skills/run/BACKGROUND.md`.
