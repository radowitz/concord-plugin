---
name: run
description: Drive a 贞观·政事堂 · Concord (Concord V3) run step by step in this session — Codex proposal, Grok review, Codex task plan, implementation by this session or native Claude subagents, real tests, read-only Codex QA, bounded repair. Use only when the user explicitly invokes /concord:run.
argument-hint: "[<request>] [--policy fast] [--require-clean] [--model qa=<id>] [--tier worker=opus] [--max-repairs N] [--review-timeout S|0] [--test '<cmd>']..."
disable-model-invocation: true
---

# /concord:run

`H` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/concord.mjs"`. The helper owns proposal, review,
planning, tests and QA. You only implement the tasks it hands you. Don't plan the request yourself
and don't run the tests yourself as a substitute.

**Never put request text or user values into a shell command.** They go into a JSON spec file.
## 1. Start

1. From `$ARGUMENTS`, take only the flags the user typed literally. The rest is the request, kept verbatim.
   If `$ARGUMENTS` has no request (bare `/concord:run`), take the goal from the current conversation: the
   task the user has been discussing or just asked for, written as a self-contained request. Ask only if
   the conversation contains no goal. Never invent one, and don't require any flag.

   Flag-to-spec mapping (literal flags only, e.g. `--policy`, `--model`, `--tier`, `--review-timeout`, `--test`): [REFERENCE.md](REFERENCE.md#run-flags-to-spec).

2. Pick the check that gates the run. Don't make the user type `--test`:
   1. If `--test` was given, use it as `"tests"`.
   2. Else if project instructions (CLAUDE.md, AGENTS.md, README, CONTRIBUTING) name the command that
      verifies changes, or the user already agreed to a gate command in this conversation (same project
      and task), use that as `"tests"`; a contextual bare `/concord:run` reuses the approved gate. Explicit
      commands are reported as `custom` (not assumed to be behavioural tests) unless they are `<pm> test`.
      Explicit checks run in the directory you start from. If the command comes from the repository's root
      instructions and the session is in a subdirectory, add `"tests_cwd": "."` (or the documented
      repo-relative directory) so it runs where those instructions mean it.
   3. Else omit `tests` and run `H checks --json` (add `--repo` for another directory). The helper reads
      the nearest `package.json` from the current directory up to the repo root: `scripts` (prefers
      `test`, then `check`/`typecheck`, then `lint`/`build`; placeholders, watch and `--fix`/`--write` scripts are
      ignored) and runs `<pm> run <script>` as argv with no shell, install or network; `start` autodetects the same.
   4. If `selected` is `null` and nothing else names a command, **ask the user** which command gates the
      run. Never guess one and never continue without a real check.
   5. When `selected.kind` is not `test` (typecheck, lint, build, check), tell the user the gate is only
      that kind (`selected.note`), and say so again in the final summary.
3. Use the **Write tool** to create `/tmp/concord-spec-<8 random hex>.json`, e.g.
   `{"request": "…"}`, adding `"tests"` only for an explicit override. Omit keys the user didn't give.
4. Run `H start --spec /tmp/concord-spec-XXXXXXXX.json` from the session's current directory (autodetection starts
   there). A dirty checkout is fine: the helper snapshots it as the baseline. On `dirty` (only with
   `--require-clean`), `open_run` or another error, show the message and stop. Never stash, reset, commit or
   delete the user's files to make it pass.

## 2. Loop

Act on the `action` of the JSON `H advance <run>` prints (last JSON document; progress goes to stderr):

| action | do |
|---|---|
| `continue` | Run the next helper stage (below). `next_stage` names it, its time limit and the Bash settings to use. |
| `implement` / `repair` | Do the step (below), then record it with the action's `done` command (`advance --done <step> --executor subagent\|main --revision <revision> --one-step`) as a **background** Bash task like any helper stage: the next stage is tests (`after_done` has its limit and `timeout_ms`). |
| `failed` | Report `failure` (`failure.kind` says timeout / stream / exit / malformed) and stop. Use `--retry` only when the user asks. |
| `await_human` | Summarise and stop (see 3). |

**Helper stages** (Codex proposal, Grok review, Codex plan, tests, Codex QA) can take many minutes. Run each as
`H advance <run> --one-step` with Bash `run_in_background: true`, `timeout` = `next_stage.background.timeout_ms`
and `description` = `next_stage.background.description`, so `/tasks` shows which stage it is. Don't wait in a
tight loop: you are notified when it ends (read its output file with Read; the final JSON is at the end). While
it runs you can answer the user, and use `H status <run> --light` or `H logs <run>` (see the `logs` skill). Never
start a second `advance` while one is live. To abandon a run use `H cancel <run>`; to stop only the current stage and keep the run open use
`H interrupt <run>` (both kill the child process groups; `TaskStop` on the Bash task is best-effort). After an
interrupt, retry only if the user wants the stage run again. Codex and Grok are external CLIs: they appear as that labelled
Bash task plus persisted logs, not as native Claude agents. If background Bash is unavailable, run the same command
in the foreground (Bash `timeout: 600000`) and tell the user that a stage longer than the host's 10-minute cap may
be cut off. Details, limits and `extend`: [BACKGROUND.md](BACKGROUND.md).

To do an `implement` or `repair` step:

- Work to the action's `request` (the original request plus all amendments) and tell the user about any
  `check_coverage` warning before you start; don't add checks or ask new questions because of it.
- Default: call the **Agent** tool with `subagent_type: "general-purpose"` and `model` set to the
  action's `agent.model` (`haiku`, `sonnet` or `opus`). Pass the task or cause JSON, the `request` and the `rules`
  text, and say "work in the current checkout; don't commit; preserve the pre-existing uncommitted edits listed in `baseline`". Report `--executor subagent`.
- For a tiny step you may edit it yourself and report `--executor main`. The helper records that as
  "inherited model, unknown", not as a model switch.
- Run steps one at a time; no parallel subagents (serial, single checkout).
- If the step can't be done, write the reason with Write and run
  `H advance <run> --failed <step> --revision <revision> --note-file <file>`.

**Changing the goal mid-run.** This plugin registers no hooks, so nothing intercepts chat: amending is best-effort and
works only because you read this. While a run is open, a new user message that changes what it should deliver
(a requirement, constraint or scope change) is recorded with the `amend` skill; status questions and discussion are
not. The user never has to retype `/concord:run`. If a native writer is still working, stop or await it first. Never
reuse a result produced for an older `revision`.

Use run/step IDs exactly as printed (`[A-Za-z0-9_-]+`). `wrong_worktree` means: use the `--repo` it names.

## 3. Finish

On `await_human`, report the steps and tasks, the check that gated the run and its `kind` and `cwd`, any check-coverage warning (say what the gate cannot show; don't invent coverage), then the `validation` fingerprint, with
`H status <run>`. Tell the user nothing was committed, pushed or deployed. They review the working tree;
run `H approve <run> --decision approve|reject` only when they explicitly ask (it only records the decision).

三省六部 labels are an organizational metaphor, not a historical equivalence. Actions, spec, model routing,
fast policy and failures: [REFERENCE.md](REFERENCE.md).
