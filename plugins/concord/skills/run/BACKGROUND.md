# Waiting, background tasks and mid-run changes

Reference for [SKILL.md](SKILL.md). `H` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/concord.mjs"`.

## What the user can see

| Where | What |
|---|---|
| `/tasks` | Each helper stage you start with `run_in_background: true` is one Bash task whose description is the stage, provider and run (for example `Concord review · grok · 20261109-…`). Codex and Grok are **external CLIs**: they are not native Claude agents or subagents. |
| the task's output file | Progress and heartbeat lines on stderr (`[concord <run> <step>] …`), then the final next-action JSON. Read it with the Read tool (`TaskOutput` was removed in Claude Code 2.1.277). |
| `H status <run> --light` | `running[]` (step, pid, elapsed, limit, last output, no-output state), the run `revision`, stage timing and recent timeline, without hashing the working tree. |
| `H logs <run>` | Raw stdout/stderr and normalised events of any step, readable while the helper runs. |

## Time limits

- Codex/Grok steps default to **1800 s each** (`limits.review_timeout_s`; `limits.role_timeout_s` sets one role; `0` = no helper deadline, wait manually). The old 120/60 s Grok numbers were one-off review budgets, not policy. Test commands keep `limits.test_timeout_s` (default 300 s each).
- The soft notice (default every 30 s, `CONCORD_HEARTBEAT_MS`) only prints `still running Ns (limit …); last output … ago` or `no output yet (process alive)`. It never kills or retries anything.
- A real timeout kills the whole process group and fails the step with `failure.kind: "timeout"`. That is not a Grok verdict (`rejected_by_review` stays unset), no model is changed, and the review is not skipped. Retry only if the user agrees: `H advance <run> --retry`.
- **Live extension.** `H extend <run> --review-timeout S` (seconds from each Codex/Grok step's start; `0` = manual) is picked up by a running helper within about a second and applies to later Codex/Grok stages of that run. A value at or below what has already elapsed is refused.
- **Background Bash timeout.** Interactive background commands have no host deadline; unattended (`-p`) runs default to 10 minutes unless `timeout` is set (max 2 h). `next_stage.background.timeout_ms` is the stage limit plus 120 s, capped at 2 h (manual waits get the 2 h cap). Never edit global environment settings for this.

## Rules while a stage is running

- One helper per repository (lock). A second `advance` fails with `locked`; follow the live one with `logs`/`status --light` instead.
- Don't poll tightly: wait for the completion notice, or look at most about every 30 s if the user asks.
- `H interrupt <run>` stops the running stage (process groups killed) but keeps the run open: the step is recorded `interrupted`, and an `amend` clears the interruption. `H cancel <run>` abandons and closes the run (it can no longer be amended). Stopping the Bash task with `TaskStop` is a best-effort fallback.
- Everything that runs a helper stage uses a background task with `--one-step`, including the `advance --done …` call after a native step (its `after_done` field gives the tests stage's limit and `timeout_ms`).
- If the session or helper dies, `/concord:resume` marks the step interrupted and re-runs nothing by itself.

## Amendments (`amend`)

`H amend <run> --spec FILE [--writer-stopped]` with JSON `{"kind": "clarify"|"scope", "text": "…"}` (written with the Write tool).

- It bumps `revision`, appends to `amendments`, and invalidates any validation. The run baseline and every file edit made so far are untouched; nothing is reverted.
- `clarify` keeps the plan and completed tasks (validated runs go back to test + QA). `scope` re-plans: the planner is told which tasks are already done. In full policy a scope change invalidates the earlier Grok approval: Grok reviews the revised request and the current changes (the proposal is not redone) before the re-plan, and planning is gated on a review at or after the last scope amendment. A docs-only fast run reverts to the full policy.
- Every later Codex, Grok and QA prompt and every worker/repair action carries the effective request. `--done`/`--failed` need `--revision N`; a result for an older revision is rejected (`stale_revision`).
- Refused with `helper_busy` while a helper runs a stage (wait for it, or `interrupt` it; not `cancel`). Refused with `writer_may_be_active` while an implement/repair step is pending until you pass `--writer-stopped`, which asserts that you stopped or awaited the native writer. The helper can't see or kill a native Agent.
- Limits: 20 amendments of 8000 characters per run. Closed runs can't be amended.
