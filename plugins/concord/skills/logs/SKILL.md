---
name: logs
description: Read the live or finished logs and normalised events of a 贞观·政事堂 · Concord run step (Codex proposal/plan/QA, Grok review, tests), read-only and bounded, even while the helper is running. Use for /concord:logs or when the user asks what a running Concord stage is doing.
argument-hint: "[run-id|latest] [--step <id>] [--stream stdout|stderr|events] [--offset N] [--limit N]"
---

# /concord:logs

`H` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/concord.mjs"`. Read-only: it takes no lock, hashes nothing and
works while a helper is running. Build arguments only from tokens that pass these checks; never paste `$ARGUMENTS`
into the shell.

- run ID `^[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$` or `latest`
- `--step` `^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$` (for example `proposal`, `review`, `plan`, `test-1`, `qa-1`)
- `--stream` one of `stdout`, `stderr`, `events`; `--attempt N`; `--command N` (test steps); `--offset`/`--limit` non-negative integers (limit ≤ 65536)

| want | command |
|---|---|
| tail of the running (else latest) step | `H logs <run> --json` |
| a stage's normalised events | `H logs <run> --step review --stream events --json` |
| read on from where you stopped | `H logs <run> --step review --stream stdout --offset <next_offset> --json` |
| is anything running | `H status <run> --light` |

The JSON has `text`, `offset`, `next_offset`, `size`, `eof`, `running` and `truncated_head`; use `next_offset`
for the next call and don't poll more often than about every 30 s. Logs hold raw provider output (including
what a provider emitted as thoughts); summarise it, and don't present internal thinking as progress. `events` are
the normalised stream events only (message, tool, usage as reported, end, error). If a step shows
`no_output: true`, say the process is alive and silent, not that it is stuck or "thinking".
