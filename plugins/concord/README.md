# 贞观·政事堂 · Concord — Claude Code plugin v0.2.2

**English** · [简体中文](https://github.com/radowitz/concord-plugin/blob/main/plugins/concord/README.zh-CN.md)

This plugin runs a Concord V3 workflow natively inside your current Claude Code session. It has no Python backend, no daemon and no nested `claude` CLI. A small Node.js helper (builtins only, no npm, no build step) runs short-lived commands. It stores durable state, calls Codex and Grok in read-only mode, runs your real tests, and tells the session what to do next. **The code is written by this session or by its native Claude subagents.**

```text
中书省 · Codex 大脑 (proposal) → 门下省 · Grok 审议 (review) → 尚书省 · Codex 编排 (task plan + dependencies)
→ 六部 · Claude Workers (this session / Agent subagents, serial) → your tests (argv, no shell)
→ 御史台 · Codex QA (read-only) → bounded Claude repair → 天子决之 · 人工审批 (you)
```

The 三省六部 labels are an organizational metaphor, not an exact historical equivalence. Each step also records its real provider, model and step ID. **You remain the final authority.** Concord never commits, pushes or deploys. An approval only records your decision, bound to the exact validated working state.

## Install

Requirements: Node ≥ 18 and git. You also need the `codex` and `grok` CLIs installed and signed in.

From GitHub (interactive, inside Claude Code):

```text
/plugin marketplace add radowitz/concord-plugin
/plugin install concord@concord-plugin
```

Equivalent CLI, user scope (the plugin then loads in future sessions):

```bash
claude plugin marketplace add radowitz/concord-plugin
claude plugin install concord@concord-plugin --scope user
```

From a local checkout:

```bash
# development, from this repository
claude --plugin-dir plugins/concord

# self-contained local marketplace: plugin assets + LICENSE only, no backend
node plugins/concord/scripts/package.mjs --out ~/concord-plugin-dist
claude plugin marketplace add ~/concord-plugin-dist
claude plugin install concord@concord-local
```

## Use

```text
/concord:run add server-side validation to the signup form
/concord:run                # bare: uses the task from the current conversation (asks only if there is none)
/concord:run --tier worker=opus --model qa=<account-listed-id> fix the race in the job queue
/concord:run --policy fast Fix the typo in README.md
/concord:run --test 'python3 -m pytest -q' fix the race in the job queue   # optional override for non-Node projects
/concord:status            # latest run: steps, providers/models, tasks, 政事堂议事 artifacts, next action
/concord:resume latest     # after a restart: reports interrupted steps, re-runs nothing on its own
/concord:logs              # live/finished logs and events of a stage (read-only, works while it runs)
```

The host records a mid-run change of goal with the internal `amend` skill; you do not type a slash command for every message.

Helper commands are listed in `node plugins/concord/scripts/concord.mjs --help`. `preflight` is a free check with no inference and no network. `models --refresh` lists the models available to your account through local CLI commands. `approve <run> --decision approve|reject` records your decision. `cancel <run>` stops a run. `logs`, `extend`, `amend` and `status --light` are described below.

## How it works

- **Starting a run.** The checkout does not need to be clean. Staged or unstaged tracked changes and untracked non-ignored files (for example `.vscode/extensions.json`) are recorded as the run's baseline: their exact content is snapshotted as git tree objects using a temporary index copy (your real `.git/index` is never written, nothing is committed, no branch moves). QA diffs and the fast-policy path gate compare against that baseline, not `HEAD`, so unrelated pre-existing work is excluded from the change diff and does not block a docs fix. It is not exempt from review: QA is told to flag a baseline defect that breaks the requested outcome. Workers are told to preserve it. Add `--require-clean` (spec `require_clean: true`) to refuse a dirty start; `preflight --require-clean` is the matching strict check. Concord never stashes, resets, commits or overwrites your work. Implementation runs serially in this checkout. v0.2 does not run parallel subagents.
- **Checks.** `--test` is optional. When the spec has no `tests`, `start` reads the nearest `package.json` from the current directory up to the repo root (no workspace scanning): `scripts` in the order `test`, `check`, `typecheck`, `lint`, `build` (placeholders like `echo ... no test specified` and watch scripts are skipped), the package manager from `packageManager` or the lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock[b]`, `package-lock.json`; conflicting lockfiles are not guessed), and runs `<pm> run <script>` as argv in that package directory. Nothing is installed and no shell is used (a `packageManager` shim such as corepack may still fetch its own binary; that is outside Concord). The choice, its source and its kind persist in the run and show in `status`; a typecheck/lint/build gate is reported as such and QA is told it is not a behavioural test. If nothing reliable is found, `start` fails with `no_tests` and the skill asks you. `node scripts/concord.mjs checks --json` previews the choice. Explicit `tests` always win.
- **State.** Run state lives in `$(git rev-parse --git-common-dir)/concord/runs/<id>/`, which is never tracked. There is one lock per repository. A step left running when the helper died is reported as `interrupted`, and only `advance --retry` re-runs it.
- **Validation.** Tests and QA must see the same working-state fingerprint. The fingerprint covers tracked and untracked files, but excludes `.git` and Concord's own state. Missing or failing tests never pass. Blocking QA findings require a repair, and repair rounds are capped (default 2). Malformed plan or QA output is rejected. Any edit after validation invalidates it. A repair that changes nothing stops the run instead of replaying tests and QA.
- **Model routing (吏部选才).** Each task gets the `haiku`, `sonnet` or `opus` alias based on its difficulty and risk. You can override this with `--tier worker=…`. The session passes the alias to the Agent tool's `model`. Work done in the main session is recorded as "inherited, actual model unknown". Codex and Grok use your account default unless you set `--model role=id`. An override is checked against the cached account list, which shows its source and timestamp. Concord never invents model IDs and never picks the "latest" model automatically.
- **Worktree binding.** Linked worktrees share one run store, so a run remembers the checkout it started in (`run.repo`). `advance`, `resume`, `amend`, `extend`, `approve` and `cancel` fail with `wrong_worktree` (naming the right `--repo`) from any other worktree, before any lock, write, signal or model call. `status`, `show`, `list` and `logs` still work from anywhere; for a foreign run `status` says the working state is unavailable instead of comparing the wrong files.
- **Check directory.** Explicit checks run in the directory you started from, like an autodetected check there. Spec `tests_cwd` (an existing repo-relative directory, no `..`) lets the host run a root command from the root even if the session is in a subpackage. The cwd is recorded in the run and each test step and shown in `status`. Runs saved before v0.2.2 keep the repository-root fallback and say so.
- **Check coverage.** After the plan, Concord compares planned files with the check's directory and `package.json` boundaries and stores a conservative `check_coverage` warning when files lie outside it or in a nested package it cannot show the script reaches. The warning appears before implementation and in the final summary. It never runs extra checks, asks extra questions, or claims coverage that script metadata cannot prove.
- **Mid-run amendments.** `amend <run> --spec FILE` takes `{"kind":"clarify"|"scope","text":"…"}`. It bumps the revision, keeps the history, invalidates validation and leaves the baseline and all edits alone. `clarify` keeps the plan; `scope` invalidates the earlier Grok approval: Grok reviews the revised request and current changes, then the run re-plans (completed tasks are listed to the planner; no new proposal). Every later Codex/Grok/QA prompt and worker action carries the effective request; `--done --revision N` rejects stale results. It is refused while a helper stage is running (wait, or `interrupt <run>`, which stops the stage but keeps the run open; `cancel` closes it for good), and while a native writer might still be editing unless `--writer-stopped` asserts it was stopped; the helper cannot kill a native Agent. This is best-effort and skill-driven: Claude Code does support `UserPromptSubmit` hooks, but this plugin registers none, so nothing intercepts chat automatically. The host amends only when the skill instructs it to and it judges your message modifies the active task.
- **Waiting and background tasks.** Codex/Grok steps default to 1800 s (`limits.review_timeout_s`, `0` = no helper deadline, per-role `limits.role_timeout_s`; the earlier 120/60 s Grok values were review budgets, not policy). A timeout kills the process group and is reported as a timeout, never as a Grok verdict; no model is changed and the review is not skipped. Soft notices every 30 s (`CONCORD_HEARTBEAT_MS`) only print elapsed time and last output. `extend <run> --review-timeout S` changes the limit of a running helper (no daemon: the helper's timer re-reads a small control file). The skill runs each stage as `advance --one-step` in a background Bash task with a suitable `timeout` and a description naming the stage, so `/tasks` shows `Concord review · grok · <run>`. Codex and Grok remain external CLIs, not native Claude agents; the Bash output file carries progress lines, and `logs` carries the rest. If background Bash is unavailable the skill falls back to the foreground, where the host's 10-minute Bash cap can cut a longer stage.
- **Logs and events.** Codex runs with `--json` (the `-o` file stays the authoritative final message, but a `turn.failed`, an unrecovered error or a truncated stream rejects the step; a transient error recovered by `turn.completed` is accepted); Grok runs with `--output-format streaming-json`, still with no tools, plan mode and no subagents, and its text events are parsed into the structured result (an `error` event, a missing `end` event, bad JSON or a non-zero exit rejects the step; older Grok builds without that format use `json`). Raw bytes land in `logs/` as they arrive, with normalised events, pid, last-output time, byte and event counts. Thought events stay only in the raw log and are never shown as progress. `logs <run> [--step ID] [--stream stdout|stderr|events] [--offset N] [--limit N]` reads them safely (regular files inside the run's logs only, at most 64 KiB per call, byte cursor `next_offset`) while the helper holds the lock. No percentages or model usage are invented.
- **Timing.** `status` shows per-stage attempts and time, the run timeline and working-state scan counts; `status --light` skips the full working-state hash while a stage runs. `approve`, tests and QA always use the full fingerprint.
- **Repair routing.** A repair uses the highest tier among the related tasks (floor sonnet, Opus for high risk or risk keywords); `--tier repair=…` still wins.
- **Speed.**
  - Planning happens in Concord's own steps, not in the session.
  - No worker processes are started.
  - Each CLI and test run has a wall-clock limit and is killed as a whole process group on timeout or cancel.
  - Model discovery happens only when you ask for it.
  - This plugin registers no hooks.
  - `--policy fast` combines the proposal and plan, and skips Grok only for a narrow docs-only typo fix (README/CHANGELOG or `docs/` prose). Concord records why. The paths actually changed are checked as well: anything else invalidates the skip and stops the run, leaving files untouched, until `--retry` runs the full review and re-plan.

Details: [skills/run/REFERENCE.md](skills/run/REFERENCE.md). Tests (source repository only): `node --test tests/claude_plugin.test.mjs`, using fake CLIs and temporary repositories.

## Limitations

- This is a functional prototype. One real native headless Claude Code task reached `validated` through Codex, Grok, main-session implementation, project tests and Codex QA. The interactive UI, native Agent execution and real long-wait controls remain unverified.
- Grok's streaming event shapes follow its public headless-mode documentation; unknown event types are counted and ignored.
- Amendments are recorded only when the host calls `amend`; this plugin registers no hooks, so nothing watches chat messages.
- Validation evidence (see `docs/verification.md` in the source repository): 93 mock tests, one native headless run, plus a standalone live Grok `streaming-json` capture (212 lines) parsed by the normaliser.
- `extend` and soft notices work only while a helper process lives; there is no daemon. Unattended Claude Code background commands normally have a 2 h maximum unless the host is configured otherwise; interactive local sessions have different host limits. A helper deadline of `0` does not override host limits.
- It runs serially only. Parallel subagents would need separate worktrees, which are not implemented.
- The helper cannot see which exact Claude model served a subagent.
- Login state of `codex` and `grok` is not checked before a run.
- Tests that write files that are not gitignored prevent validation.
- Git submodules and nested repositories are not supported: preflight and start refuse them.
- Linked worktrees share one run store and lock, so only one open run per repository.
- The fingerprint hashes every non-ignored file, so it is slower on very large repositories.
