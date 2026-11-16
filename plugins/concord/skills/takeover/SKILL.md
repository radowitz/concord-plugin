---
name: takeover
description: Ask the user whether Codex CLI (ChatGPT login) should take over the remaining coding and repairs of a 贞观·政事堂 · Concord run after Claude reported a real usage limit, and record only their own explicit decision. Use for /concord:takeover, or when a Concord action is `await_switch`. Never use it to decide for the user.
argument-hint: "[run-id|latest]"
---

# /concord:takeover

`H` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/concord.mjs"`. Accept only a run ID matching
`^[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$` or `latest`. Never paste `$ARGUMENTS` into the shell.

A handoff moves the **remaining task and repair coding of this one run** from Claude to Codex CLI. The run, its
plan, completed tasks, request and amendments, test commands and every file already edited stay as they are.
Nothing is stashed, reset, committed, pushed or deployed. It needs the user's own explicit decision every time:
`on_claude_limit: ask` only means "ask"; it is never consent, and neither is silence, a timeout or your judgment.

## When this session still works (a worker or the Agent call hit the limit)

1. Report the limit with the action's `on_limit.report` command (see the run skill): write the exact error text,
   verbatim and nothing else, to a file with Write, then
   `H quota <run> --step <step> --revision <revision> --note-file <file>`.
   - `await_switch`: go on with step 2.
   - `paused` (a temporary rate limit, `on_claude_limit: stop`, or the user declined earlier): tell the user the
     exact error and the `message`, then stop. Do not offer a switch. Wait for the reset, then
     `H resume <run> --claude` when the user asks.
   - `not_a_limit`: the text was an auth error, a timeout, a connection error or failing work. Tell the user the
     error and record `--failed` as usual. Never rephrase an error to make it look like a limit.
2. Stop or await the native writer (TaskStop the Agent, or wait for it). Only then run
   `H takeover <run> --writer-stopped --json`. It checks that Codex CLI is signed in with ChatGPT (an API-key or
   unknown login is refused: no API billing), refreshes Codex model metadata if it is older than a day, and returns
   `proposal` plus a ready-to-show `text`. Nothing is switched.
3. Show the user the `text`: the reason, the remaining tasks, and the frozen low/normal/high Codex model and
   effort table with its source, time and "stale/unverified" marks. Say that the table is a heuristic from provider
   descriptions, not a benchmark. Then ask with the host question UI (AskUserQuestion): **switch to Codex / wait and
   keep Claude / stop**. Never approve for them and never pick a default.
4. Pass exactly what they chose:
   - switch: the `approve` argv from step 2 (`H takeover <run> --proposal <id> --decision approve --writer-stopped`)
   - not now: the `decline` argv. The run stays open and paused. A declined proposal can never be approved later.
   - a different model: `H takeover <run> --writer-stopped --json --codex-routes low=<model>[@effort],high=…` and
     ask again with the new table. Models must be in the account list; efforts must be declared for that model.
   `stale_proposal` means the run or checkout changed since the proposal: prepare a new one and ask again.
5. After `consented: true` the action is `continue`: run stages as in the run skill
   (`H advance <run> --one-step` as a labelled background Bash task). The Codex writer, checks, QA and Codex repairs
   are all helper stages now. Do not implement the step yourself and do not send `--done`: both are refused.

## When this session itself is out of quota

It may be unable to run any skill, and nothing pops up automatically (this plugin registers no hooks). The user
runs the command that `start` and `status` print as `claude_limit.takeover_terminal`, in a plain terminal:

```text
node /abs/path/to/concord/scripts/concord.mjs takeover <run> --writer-stopped --repo /abs/path/to/checkout
```

It prints the same proposal and asks in the terminal. Only the typed word `approve` consents; `decline`, an empty
line or closing the input records no consent. Then `… drive <run> --repo …` runs the rest in that terminal (no
daemon), or add `--drive` to the takeover command to continue straight away.

## What to tell the user

- Consent to a handoff is **not approval of the result**. `approve` on the validated state stays a separate decision.
- The model table is frozen for this run and revision. An amendment or a re-plan needs a new proposal and consent.
- If Codex cannot finish a step (its own quota, login, an unavailable model, a blocked sandbox, a truncated
  answer, a changed Git state) the run pauses with the edits kept. Nothing is retried and no other model is tried:
  `H resume <run> --retry-codex` only when the user asks, or `H resume <run> --claude` to give the step back.
- The helper cannot see or stop a native Claude writer: `--writer-stopped` is an acknowledgement, not a check.

Details: `${CLAUDE_PLUGIN_ROOT}/skills/run/REFERENCE.md` (Claude limit and Codex handoff).
