---
name: run
description: Drive a 贞观·政事堂 · Concord (Concord V3) run step by step in this session — Codex proposal, Grok review, Codex task plan, implementation by this session or native Claude subagents, real tests, read-only Codex QA, bounded repair. Use only when the user explicitly invokes /concord:run.
argument-hint: "[--test '<cmd>']... [--policy fast] [--model qa=<id>] [--tier worker=opus] [--max-repairs N] <request>"
disable-model-invocation: true
---

# /concord:run

`H` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/concord.mjs"`. The helper owns proposal, review,
planning, tests and QA. You only implement the tasks it hands you. Don't plan the request yourself
and don't run the tests yourself as a substitute.

**Never put request text or user values into a shell command.** They go into a JSON spec file.

## 1. Start

1. From `$ARGUMENTS`, take only the flags the user typed literally. The rest is the request, kept verbatim.

   | flag | spec |
   |---|---|
   | `--test '<cmd>'` (repeatable) | `"tests": ["<cmd>", …]` (argv split, no shell; arrays also accepted) |
   | `--policy fast` | `"policy": "fast"` |
   | `--model <role>=<id>` (proposal/review/plan/qa) | `"models": {"<role>": "<id>"}` |
   | `--tier worker=<haiku\|sonnet\|opus>`, `--tier repair=…` | `"models": {"worker": "…"}` |
   | `--max-repairs N` | `"limits": {"max_repairs": N}` |

2. If no test command was given, ask the user which one gates the run. Never guess one.
3. Use the **Write tool** to create `/tmp/concord-spec-<8 random hex>.json`, e.g.
   `{"request": "…", "tests": ["npm test"]}`. Omit keys the user didn't give.
4. Run `H start --spec /tmp/concord-spec-XXXXXXXX.json`. On `dirty`, `open_run` or another error,
   show the message and stop. Never stash, reset, commit or delete the user's files to make it pass.

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
  text, and say "work in the current checkout; don't commit". Report `--executor subagent`.
- For a tiny step you may edit it yourself and report `--executor main`. The helper records that as
  "inherited model, unknown", not as a model switch.
- Run steps one at a time. Don't start parallel subagents: v0.2 is serial in a single checkout.
- If the step can't be done, write the reason with Write and run
  `H advance <run> --failed <step> --note-file <file>`.

Only use run IDs and step IDs exactly as the helper printed them. They match `[A-Za-z0-9_-]+`.

## 3. Finish

On `await_human`, report the steps and tasks, then the `validation` fingerprint, with
`H status <run>`. Tell the user that nothing was committed, pushed or deployed. They review the
working tree and can record a decision with
`H approve <run> --decision approve|reject`. Run that only when they explicitly ask. It only
records the decision and does nothing else.

The 三省六部 labels are an organizational metaphor, not a historical equivalence. Details on actions,
the spec, model routing, fast policy and failure handling are in [REFERENCE.md](REFERENCE.md).
