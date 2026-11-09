# Concord run reference

## Roles and steps

| Step ID | Display role | Provider | Who runs it |
|---|---|---|---|
| `proposal` | 中书省 · Codex 大脑 | `codex exec --sandbox read-only` | helper |
| `review` | 门下省 · Grok 审议 | `grok` in an empty temp dir: `--tools ""` (no tools), `--max-turns 1`, `--permission-mode plan`, JSON schema; all context is inline in the prompt | helper |
| `plan` | 尚书省 · Codex 编排 | `codex exec --sandbox read-only` (task dependency plan) | helper |
| `task-<id>` | 六部 · Claude Workers | this session or a native Agent subagent | **you** |
| `test-<n>` | 测试 · 本地命令 | your test argv, `shell: false` | helper |
| `qa-<n>` | 御史台 · Codex QA | `codex exec --sandbox read-only` | helper |
| `repair-<n>` | 六部 · Claude 修复 | this session or a subagent | **you** |
| `approval` | 天子决之 · 人工审批 | human, via `approve` | user |

The 三省六部 labels are an organizational metaphor, not an exact historical equivalence. The real provider, model and step ID are always recorded alongside them.

## Action JSON (from `advance`, `resume`, `status --json` → `next`)

- `implement`: includes `step`, `task` (`id`, `title`, `description`, `files`, `depends_on`, `difficulty`, `risk`), `tier`, `tier_reason`, `agent` `{subagent_type, model}`, `rules`, `done` (argv) and `progress`.
- `repair`: includes `step`, `round`/`max_rounds`, `agent`, `rules`, and `cause`. `cause.kind` is `tests` (failing argv with stdout/stderr tails) or `qa` (`findings`; `inconsistent_verdict` means a "pass" verdict that still listed blocking findings).
- `continue`: helper steps remain, but the time budget for this call (`--budget`, default 560 s) ran out.
- `failed`: includes `failure` `{step, error}`. The failure is stored on disk. `advance` will not re-run anything until it gets `--retry`.
- `await_human`: includes `validation` `{fingerprint, tests_step, qa_step}`.

## Suggested subagent prompt

> You are a Concord 六部 · Claude worker. Implement exactly this task in the current checkout: `<task JSON>`. Rules: `<rules>`. When you're done, list the files you changed. Don't commit.

## Spec (`start --spec`)

```json
{"request": "…", "tests": [["npm", "test"], "python3 -m pytest -q"],
 "policy": "full", "models": {"qa": "account_default", "worker": "opus"},
 "limits": {"cli_timeout_s": 480, "test_timeout_s": 300, "max_repairs": 2}}
```

Unknown keys are rejected. A test string is split into argv with simple quoting. Pipes, redirects, `$`, backticks and `;`/`&` are rejected, so use an argv array or a script.

## Model routing (吏部选才)

- **Claude tiers.** Each task is routed deterministically. High difficulty, high risk, or a risk keyword (auth, payment, migration, security…) gets `opus`. Low difficulty with low risk gets `haiku`. Everything else gets `sonnet`. `models.worker` and `models.repair` override this. These are current Agent-tool aliases, and Claude Code resolves them. The helper never records an exact Claude model ID it didn't observe, and work done in the main session is recorded as inherited/unknown.
- **External roles** (`proposal`, `review`, `plan`, `qa`) use the CLI account default (no `--model` flag) unless overridden. After `models --refresh`, an override must appear in the cached account list for that provider. Otherwise it is recorded as an "unverified user override". The helper never ranks or picks "latest" versions automatically.
- **Discovery** runs only on explicit `models --refresh`, through `codex debug models` and `grok models`. Results are cached with source and timestamp. Stages never re-discover.

## Policies

- **full** (default): Codex proposal → Grok review → Codex plan → implementation → tests → QA → bounded repair.
  - Grok `reject` stops the run.
  - Grok `revise` feeds its `required_changes` into the plan.
- **fast** (opt-in): allowed only for a narrow whole-request docs fix, such as "Fix the typo in README.md" or "修正 README.md 中的错别字", with no risk keywords. Codex proposal and plan come back in one call. Grok is skipped only if every planned file is safe documentation: `README`/`CHANGELOG` at any depth, or `.md/.rst/.txt/.adoc` files under `docs/`. Never code, config, lockfiles, CI, `AGENTS.md`/`CLAUDE.md`/`SKILL.md`, or anything under `skills/`, `plugins/` or dot-directories. Otherwise the run reverts to full policy (Grok review plus a re-plan).
  - The **actual** changed paths are gated too (modified, new or deleted vs the baseline), at every `--done` and again before validation. If any path falls outside the allowlist, the skipped review is marked `invalidated` and the run fails closed with `fast_gate`. Files are left as they are. `advance --retry` switches to full policy: Grok reviews the proposal plus the already-changed paths, then Codex re-plans.
  - Every decision is recorded in `policy_notes`.

## Validation rules

- **Clean start.** `start` requires a clean checkout (no tracked changes, no untracked non-ignored files), an existing commit, and no other open run.
- **Fingerprint.** It is a sha256 over the path, exec bit and content of every tracked and untracked non-ignored file. It excludes `.git` and Concord's state.
- **Submodules unsupported.** Gitlinks and nested repositories are not fingerprinted, so `preflight` reports `no_submodules` and `start` refuses (`submodule`) rather than validate changes it cannot see.
- **Worktrees.** Subdirectories and linked worktrees resolve to the shared `git-common-dir`, so all worktrees of one repository share the run store, the lock and the one-open-run rule.
- **Tests.** Tests must pass, and must leave the fingerprint unchanged.
- **QA.** QA runs only when the fingerprint matches the last passing test run, and must leave it unchanged. It passes only with `verdict: pass` and zero blocking findings.
- **Repairs.** Failing tests or QA findings start a repair, up to `max_repairs` rounds. After that the run is `failed`. A repair reported `--done` without changing the fingerprint fails immediately (`noop_repair`). Tests and QA are not replayed, and no round is used; `advance --retry` hands back the same repair step.
- **Invalidation.** Any change after validation invalidates it. `approve` refuses, and the next `advance` re-runs tests and QA.
- **Malformed output.** Plan or QA output that is malformed (bad JSON, unknown dependency, cycle, unsafe path, missing fields) is rejected and saved as `artifacts/<step>.rejected.a<n>.json`.

## State, locking, interruption

- **State location.** State lives in `$(git rev-parse --git-common-dir)/concord/runs/<id>/`: `run.json`, `spec.json`, `prompts/`, `logs/`, `artifacts/`. Override it with `CONCORD_STATE_DIR`.
- **Lock.** One helper at a time per repository (`concord/lock`). A lock left by a dead process is replaced, and that is recorded.
- **Interrupted steps.** A step left `running` by a dead helper is marked `interrupted`. It is never re-run automatically; `advance --retry` re-runs it.
- **Timeouts and cancellation.** External CLIs and tests each run in their own process group with a wall-clock timeout. On timeout, SIGINT/SIGTERM or `cancel`, the whole group is killed, then the result is recorded.
- **`cancel <run>`.** Closes the run and leaves files as they are.
