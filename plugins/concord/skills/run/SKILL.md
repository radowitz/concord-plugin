---
name: run
description: Drive a 贞观·政事堂 · Concord (Concord V3) run step by step in this session — Codex proposal, Grok review, Codex task plan, implementation by this session or native Claude subagents, real tests, read-only Codex QA, bounded repair. Use only when the user explicitly invokes /concord:run.
argument-hint: "[<request>] [--policy fast] [--require-clean] [--model qa=<id>] [--tier worker=opus] [--max-repairs N] [--test '<cmd>']..."
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

   | flag | spec |
   |---|---|
   | `--test '<cmd>'` (repeatable, optional advanced override) | `"tests": ["<cmd>", …]` (argv split, no shell; arrays also accepted) |
   | `--policy fast` | `"policy": "fast"` |
   | `--model <role>=<id>` (proposal/review/plan/qa) | `"models": {"<role>": "<id>"}` |
   | `--tier worker=<haiku\|sonnet\|opus>`, `--tier repair=…` | `"models": {"worker": "…"}` |
   | `--max-repairs N` | `"limits": {"max_repairs": N}` |
   | `--require-clean` | `"require_clean": true` (opt-in strict start; default is to allow a dirty checkout) |

2. Pick the check that gates the run. Don't make the user type `--test`:
   1. If `--test` was given, use it as `"tests"`.
   2. Else if project instructions (CLAUDE.md, AGENTS.md, README, CONTRIBUTING) name the command that
      verifies changes, or the user already agreed to a gate command in this conversation (same project
      and task), use that as `"tests"`; a contextual bare `/concord:run` reuses the approved gate. Explicit
      commands are reported as `custom` (not assumed to be behavioural tests) unless they are `<pm> test`.
   3. Else omit `tests` and run `H checks --json` (add `--repo` for another directory). The helper reads
      the nearest `package.json` from the current directory up to the repo root: `scripts` (prefers
      `test`, then `check`/`typecheck`, then `lint`/`build`; placeholders, watch scripts and `--fix`/`--write` scripts are ignored),
      `packageManager` and lockfiles (npm/pnpm/yarn/bun). It runs `<pm> run <script>` as argv with no
      shell, install or network, and `start` autodetects the same command.
   4. If `selected` is `null` and nothing else names a command, **ask the user** which command gates the
      run. Never guess one and never continue without a real check.
   5. When `selected.kind` is not `test` (typecheck, lint, build, check), tell the user the gate is only
      that kind (`selected.note`), and say so again in the final summary.
3. Use the **Write tool** to create `/tmp/concord-spec-<8 random hex>.json`, e.g.
   `{"request": "…"}`, adding `"tests"` only for an explicit override. Omit keys the user didn't give.
4. Run `H start --spec /tmp/concord-spec-XXXXXXXX.json` from the session's current directory (autodetection starts there). A dirty checkout is fine: do not ask the user
   to clean up first. The helper snapshots it as the run baseline and reports it in `baseline`. On `dirty`
   (only with `--require-clean`), `open_run` or another error, show the message and stop. Never stash,
   reset, commit or delete the user's files to make it pass.

## 2. Loop

Run `H advance <run>` with Bash `timeout: 600000`, then act on the `action` field of the JSON it prints:

| action | do |
|---|---|
| `continue` | Run `advance <run>` again. |
| `implement` / `repair` | Do the step (below), then run `H advance <run> --done <step> --executor subagent\|main`. |
| `failed` | Report `failure` to the user and stop. Use `--retry` only when they ask. |
| `await_human` | Summarise and stop (see 3). |

To do an `implement` or `repair` step:

- Default: call the **Agent** tool with `subagent_type: "general-purpose"` and `model` set to the
  action's `agent.model` (`haiku`, `sonnet` or `opus`). Pass the task or cause JSON and the `rules`
  text, and say "work in the current checkout; don't commit; preserve the pre-existing uncommitted edits listed in `baseline`". Report `--executor subagent`.
- For a tiny step you may edit it yourself and report `--executor main`. The helper records that as
  "inherited model, unknown", not as a model switch.
- Run steps one at a time. Don't start parallel subagents: v0.2 is serial in a single checkout.
- If the step can't be done, write the reason with Write and run
  `H advance <run> --failed <step> --note-file <file>`.

Only use run IDs and step IDs exactly as the helper printed them. They match `[A-Za-z0-9_-]+`.

## 3. Finish

On `await_human`, report the steps and tasks, the check that gated the run and its `kind`, then the `validation` fingerprint, with
`H status <run>`. Tell the user that nothing was committed, pushed or deployed. They review the
working tree and can record a decision with
`H approve <run> --decision approve|reject`. Run that only when they explicitly ask. It only
records the decision and does nothing else.

The 三省六部 labels are an organizational metaphor, not a historical equivalence. Details on actions,
the spec, model routing, fast policy and failure handling are in [REFERENCE.md](REFERENCE.md).
