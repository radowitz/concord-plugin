# Concord run reference

## Run flags to spec

The `/concord:run` flags the user types literally map to the JSON spec (see Spec below):

| flag | spec |
|---|---|
| `--test '<cmd>'` (repeatable, optional advanced override) | `"tests": ["<cmd>", …]` (argv split, no shell; arrays also accepted) |
| `--policy fast` | `"policy": "fast"` |
| `--model <role>=<id>` (proposal/review/plan/qa) | `"models": {"<role>": "<id>"}` |
| `--tier worker=<haiku\|sonnet\|opus\|fable\|candidate key>`, `--tier repair=…` | `"models": {"worker": "…"}` / `{"repair": "…"}` (`opus` = Opus 5.5/xhigh, `fable` = Fable 5.2/high via packaged agents; full model IDs are rejected) |
| `--max-repairs N` | `"limits": {"max_repairs": N}` |
| `--review-timeout S` (`0` = wait manually, no helper deadline) | `"limits": {"review_timeout_s": S}` (default 1800 per Codex/Grok step) |
| `--require-clean` | `"require_clean": true` (opt-in strict start; default is to allow a dirty checkout) |

## Roles and steps

| Step ID | Display role | Provider | Who runs it |
|---|---|---|---|
| `proposal` | 中书省 · Codex 大脑 | `codex exec --json --sandbox read-only` (`-o` file = authoritative final message; stdout JSONL = progress/logs) | helper |
| `review` | 门下省 · Grok 审议 | `grok` in an empty temp dir: `--output-format streaming-json` (legacy `json` if `--help` lacks it), `--tools ""` (no tools), `--no-subagents`, `--max-turns 1`, `--permission-mode plan`, JSON schema; all context is inline in the prompt | helper |
| `plan` | 尚书省 · Codex 编排 | `codex exec --json --sandbox read-only` (task dependency plan) | helper |
| `task-<id>` | 六部 · Claude Workers | this session or a native Agent subagent | **you** |
| `test-<n>` | 测试 · 本地命令 | your test argv, `shell: false` | helper |
| `qa-<n>` | 御史台 · Codex QA | `codex exec --json --sandbox read-only` | helper |
| `repair-<n>` | 六部 · Claude 修复 | this session or a subagent | **you** |
| `approval` | 天子决之 · 人工审批 | human, via `approve` | user |

The 三省六部 labels are an organizational metaphor, not an exact historical equivalence. The real provider, model and step ID are always recorded alongside them.

## Action JSON (from `advance`, `resume`, `status --json` → `next`)

- `implement`: includes `step`, `task` (`id`, `title`, `description`, `files`, `depends_on`, `difficulty`, `risk`), `tier` (capability tier), `tier_reason`, `agent` (pass exactly these keys to the Agent tool: `{subagent_type, model}` for an alias, `{subagent_type}` alone for a packaged agent), `agent_note`, `main_session` `{allowed, note}` (guidance only: `allowed` is true just for a low-tier task on a policy-selected alias; never for packaged agents, overrides, fallbacks, harder tiers or repairs), `route` (`candidate`, `requested`, `pinned_model`, `effort`, `source`, `reason`, `readiness`, `actual: not observed`, `policy`, `published_docs`, `caveat`), `fallback` (`available`, `candidate`, `when`, `switch` argv), `revision`, `request` (original request + amendments), `amendments`, `check_coverage` (only when it warns), `rules`, `done` (argv, ends with `--revision N`) and `progress`.
- `repair`: includes `step`, `round`/`max_rounds`, `agent`/`route`/`fallback`/`tier`/`tier_reason` (the highest capability tier among the related tasks, floor sonnet, routed through the frozen policy; `models.repair` overrides), `revision`, `request`, `rules`, and `cause`. `cause.kind` is `tests` (failing argv with stdout/stderr tails) or `qa` (`findings`; `inconsistent_verdict` means a "pass" verdict that still listed blocking findings).
- `continue`: helper steps remain (after `--one-step`, or when `--budget` ran out). `next_stage` gives `step`, `provider`, `limit_s` and the suggested background Bash `timeout_ms`/`description`; `next` is the argv to run.
- `failed`: includes `failure` `{step, error, kind}` (`kind`: `timeout`, `exit`, `process_error`, `stream`, `malformed`, `interrupted`; `interrupted` with `by_user` comes from `interrupt`; a Grok reject verdict has `rejected_by_review` instead). The failure is stored on disk. `advance` will not re-run anything until it gets `--retry`.
- `await_human`: includes `validation` `{fingerprint, tests_step, qa_step, revision, check_cwd, check_coverage}`; a coverage warning is also spelled out in `message`.

## Suggested subagent prompt

> You are a Concord 六部 · Claude worker. Implement exactly this task in the current checkout: `<task JSON>`. Rules: `<rules>`. When you're done, list the files you changed. Don't commit.

## Spec (`start --spec`)

```json
{"request": "…", "tests": [["npm", "test"], "python3 -m pytest -q"],
 "policy": "full", "models": {"qa": "account_default", "worker": "opus"},
 "limits": {"review_timeout_s": 1800, "role_timeout_s": {"review": 3600}, "test_timeout_s": 300, "max_repairs": 2}}
```

`tests_cwd` (optional, explicit `tests` only) is a repo-relative existing directory (no `..`, no symlink escape) that the explicit tests run in; default is the directory `start` was run from. `limits.review_timeout_s` (0..86400, default 1800, `0` = no helper deadline) is the Codex/Grok wall-clock limit per step; `limits.role_timeout_s` overrides it per role (`proposal|review|plan|qa`); the legacy `limits.cli_timeout_s` applies only when it is given explicitly and `review_timeout_s` is not.

`tests` is optional: when omitted, `start` autodetects (`H checks --json` previews it). `require_clean` is an optional boolean. Unknown keys are rejected. A test string is split into argv with simple quoting. Pipes, redirects, `$`, backticks and `;`/`&` are rejected, so use an argv array or a script.

## Model routing (吏部选才)

- **Capability tiers.** Each task is routed deterministically. High difficulty, high risk, or a risk keyword (auth, payment, migration, security…) gets the `opus` tier. Low difficulty with low risk gets `haiku`. Everything else gets `sonnet`. A tier is a capability class, not a model, and families are never ranked by version number.
- **Requested candidate.** The run's frozen policy maps each tier to a candidate. Built-in default (a user preference, not a benchmark): `haiku` → alias `haiku`; `sonnet` → alias `sonnet`; `opus` → `fable-5.2-high` (packaged agent `concord:fable-worker`: `claude-fable-5-2`, effort `high`) with declared fallback `opus-5.5-xhigh` (`concord:opus-worker`: `claude-opus-5-5`, effort `xhigh`). The Agent tool's per-call `model` only takes `haiku|sonnet|opus|fable`, so full IDs and effort exist only in packaged-agent frontmatter, and a packaged agent is called without `model`.
- **Overrides.** `models.worker` / `models.repair` take `haiku`, `sonnet`, `opus` (= `opus-5.5-xhigh`), `fable` (= `fable-5.2-high`) or a candidate key (`opus-alias`, `fable-alias`, …). Anything else, including a full model ID or `inherit`, fails `spec` before a run exists. An override has no fallback. The task keeps `computed_tier` next to the override.
- **Fallback.** `advance <run> --use-fallback <step> --revision N --note-file <exact host error>` switches the pending step to its declared fallback and records it (`route_events`, `policy_notes`, timeline). It is refused (`no_fallback`) for overrides, legacy runs, tiers without a fallback, or a second switch. The helper never switches or retries on its own.
- **Truthful records.** Steps store `model.requested` (candidate), `pinned_model`, `effort`, `subagent_type` and `actual` (always "not observed"); `--executor main` is recorded as inherited/unknown.
- **Profile.** `models --routing FILE` validates and stores an overlay profile in `CONCORD_CACHE_DIR` (`routing.json`); `models --reset-routing` removes it. Keys: `name`, `note`, `candidates` (`{"alias": …}` or `{"agent": "<packaged agent>"}`, plus `tiers`), `routes` (`<tier>: {primary, fallback}`; tiers may be written `low|medium|high`), `baselines`, `overrides`. Refused: unknown keys, full IDs as aliases, unknown agents, a Haiku/Sonnet-family candidate for a harder tier, a route to an ineligible candidate. A published alias outside the documented four needs `"host_compatible": true` and must be in the docs cache.
- **Frozen snapshot.** `run.routing` holds the resolved policy, the published-alias snapshot (source, `fetched_at`, refresh state) and the caveat. Runs without it (saved by ≤ 0.2.2) request the tier alias directly, as before.
- **Published aliases (advisory).** Fetched from `https://code.claude.com/docs/en/model-config.md` only at an admitted `start` with a missing or day-old cache, and on `models --refresh`: one HTTPS GET, ≤ 3 s total, ≤ 512 KiB, redirects only to official domains. Only plain family rows of the alias table are accepted (`default`, `best`, `opusplan`, `[1m]` variants and prose are ignored). Failure keeps the last good cache (`claude-models.json`) and backs off (15 min doubling to 6 h). `CONCORD_MODEL_DISCOVERY=off` disables it. It is not an account list and never selects a model.
- **Outcome ledger (advisory).** `approve --decision approve` appends one sample to `outcomes.json` (≤ 200 runs, one per run id) only for a clean run: validated, each task run once by a native subagent on one requested candidate, measured turnaround present, and no repair, amendment, fallback, failed/interrupted step, invalidation, main-session step or below-tier override. Each sample stores the request identity (kind, alias, agent type, pinned model, effort). `models --observations` compares only samples whose identity still equals what that candidate key means in the current policy (others are counted under `excluded`: `obsolete_identity`, `unknown_candidate`, `missing_identity`), per cohort (tier/difficulty/risk) against the tier baseline: `advisory_faster` needs ≥ 3 samples on both sides and a ≥ 20 % lower median, otherwise `no_qualifying_evidence` / `no_clear_improvement`. Routing never changes from it.
- **External roles** (`proposal`, `review`, `plan`, `qa`) use the CLI account default (no `--model` flag) unless overridden. After `models --refresh`, an override must appear in the cached account list for that provider. Otherwise it is recorded as an "unverified user override". The helper never ranks or picks "latest" versions automatically.
- **Codex/Grok discovery** runs only on explicit `models --refresh`, through `codex debug models` and `grok models`. Results are cached with source and timestamp. Stages never re-discover.

## Policies

- **full** (default): Codex proposal → Grok review → Codex plan → implementation → tests → QA → bounded repair.
  - Grok `reject` stops the run.
  - Grok `revise` feeds its `required_changes` into the plan.
- **fast** (opt-in): allowed only for a narrow whole-request docs fix, such as "Fix the typo in README.md" or "修正 README.md 中的错别字", with no risk keywords. Codex proposal and plan come back in one call. Grok is skipped only if every planned file is safe documentation: `README`/`CHANGELOG` at any depth, or `.md/.rst/.txt/.adoc` files under `docs/`. Never code, config, lockfiles, CI, `AGENTS.md`/`CLAUDE.md`/`SKILL.md`, or anything under `skills/`, `plugins/` or dot-directories. Otherwise the run reverts to full policy (Grok review plus a re-plan).
  - The **actual** changed paths are gated too (modified, new or deleted vs the start baseline; work that was already dirty does not count), at every `--done` and again before validation. If any path falls outside the allowlist, the skipped review is marked `invalidated` and the run fails closed with `fast_gate`. Files are left as they are. `advance --retry` switches to full policy: Grok reviews the proposal plus the already-changed paths, then Codex re-plans.
  - Every decision is recorded in `policy_notes`.

## Validation rules

- **Baseline.** `start` needs an existing commit and no other open run. A dirty checkout is allowed. `baseline` in `run.json` records `head`, `dirty` (porcelain entries `{xy, path, orig?}` read with `-z`, so names with spaces and renames work), `index_tree` (what was staged), `work_tree` (exact on-disk content of tracked + non-ignored untracked files) and `fingerprint`. Trees are written through a temporary `GIT_INDEX_FILE` copy that is deleted afterwards; the real index is untouched, nothing is committed, and a private ref `refs/concord/baseline/<run>` keeps the tree from being garbage-collected. QA diffs, the `changed paths` shown to Grok and the fast-policy gate compare the current state against `work_tree`. Runs persisted by v0.2.0 have only `head` (they always started clean) and fall back to it. `require_clean: true` (`--require-clean`) refuses a dirty start with `dirty`.
- **Preserving user work.** Worker/repair actions include `baseline` (pre-existing entries) and a rule not to revert, stage or delete unrelated work. Planning, review and QA prompts carry the same list, and QA is told not to flag pre-existing work.
- **Fingerprint.** It is a sha256 over the path, exec bit and content of every tracked and untracked non-ignored file. It excludes `.git` and Concord's state.
- **Submodules unsupported.** Gitlinks and nested repositories are not fingerprinted, so `preflight` reports `no_submodules` and `start` refuses (`submodule`) rather than validate changes it cannot see.
- **Worktrees.** Subdirectories and linked worktrees resolve to the shared `git-common-dir`, so all worktrees of one repository share the run store, the lock and the one-open-run rule. Every mutating command (`advance`, `resume`, `amend`, `extend`, `approve`, `cancel`) is bound to the saved `run.repo`: from another worktree it fails `wrong_worktree` (naming the right `--repo`) before any lock, write, signal or model call. `status`, `show`, `list` and `logs` stay readable from any worktree; for a foreign run the working-state fingerprint is reported as unavailable, never compared.
- **Check cwd.** Explicit checks run in the invocation directory (`test_selection.cwd`, shown in `checks`, `status` and each test step), or in `spec.tests_cwd`. Autodetected checks run in their package directory, so the same intent gives the same cwd. Saved runs without `cwd` metadata keep the old repository-root fallback and say so (`cwd_source`).
- **Check coverage.** After planning, and again at validation, planned/changed non-doc files are compared with the check's cwd and `package.json` boundaries. Files outside the cwd, or in a nested package an auto-selected script may not reach, give a persisted `check_coverage` warning (`outside_check_cwd`, `nested_package_unknown`, `no_files_listed`). Script contents are never analysed, so `ok` only means no gap was detected. Nothing is added or run because of a warning.
- **Amendments.** `amend` persists `revision` and `amendments`, invalidates validation and keeps the baseline and all edits. See [BACKGROUND.md](BACKGROUND.md). Runs saved before v0.2.2 are revision 1 and accept `--done` without `--revision`.
- **Autodetected checks.** Nearest `package.json` from the cwd up to the repo root; `scripts` order `test` → `check` → `typecheck` → `lint` → `build`; skipped: scripts with `--fix`/`--write` (they would mutate source), placeholders (`echo`/`true`/`exit 0`/"no test specified") and watch scripts (`--watch`, `-w`, `nodemon`, `watch`). Package manager: `packageManager` field, else the lockfile (conflicting lockfiles or a manager missing from PATH → script skipped, reason recorded). Command: `<pm> run <script>` as argv with cwd = the package dir. No shell, install or network from Concord. Stored in `run.test_selection` `{mode, kind, source, script, package_manager, cwd, skipped}` and in `validation.check_kind`. Explicit `tests` are kind `custom` (never assumed behavioural; only `<pm> test` / `<pm> run test` count as `test`); saved runs without metadata also read as `custom`. Non-`test` kinds are reported as typecheck/lint/build-only in `status`, `await_human` and the QA prompt. No reliable command → `no_tests`, ask the user.
- **Tests.** Tests must pass, and must leave the fingerprint unchanged.
- **QA.** QA runs only when the fingerprint matches the last passing test run, and must leave it unchanged. It passes only with `verdict: pass` and zero blocking findings.
- **Repairs.** Failing tests or QA findings start a repair, up to `max_repairs` rounds. After that the run is `failed`. A repair reported `--done` without changing the fingerprint fails immediately (`noop_repair`). Tests and QA are not replayed, and no round is used; `advance --retry` hands back the same repair step.
- **Invalidation.** Any change after validation invalidates it. `approve` refuses, and the next `advance` re-runs tests and QA.
- **Malformed output.** Plan or QA output that is malformed (bad JSON, unknown dependency, cycle, unsafe path, missing fields) is rejected and saved as `artifacts/<step>.rejected.a<n>.json`.

## State, locking, interruption

- **State location.** State lives in `$(git rev-parse --git-common-dir)/concord/runs/<id>/`: `run.json`, `spec.json`, `prompts/`, `logs/`, `artifacts/`. Override it with `CONCORD_STATE_DIR`.
- **Lock.** One helper at a time per repository (`concord/lock`). A lock left by a dead process is replaced, and that is recorded.
- **Interrupted steps.** A step left `running` by a dead helper is marked `interrupted`. It is never re-run automatically; `advance --retry` re-runs it.
- **Timeouts and cancellation.** External CLIs and tests each run in their own process group with a wall-clock timeout (Codex/Grok default 1800 s, `0` = none; tests default 300 s each). Soft heartbeat notices never kill anything. On timeout, SIGINT/SIGTERM or `cancel`, the whole group is killed, then the result is recorded.
- **Logs and events.** Per Codex/Grok attempt: `logs/<step>.a<n>.stdout.log` / `.stderr.log` (exact raw bytes, written as they arrive), `.events.jsonl` (normalised events, capped at 2 MiB; thought/reasoning content is never copied into it), `.last.txt` (Codex final message). Test commands log to `logs/test-<n>.<i>.*.log`. The step record keeps `pid`, `last_output_at`, `bytes`, `event_counts`, `no_output`, `process_ms`, `timeout_s`. `timeline.jsonl` has stage start/end, heartbeats and amendments; `control.json` holds a live `extend`. `logs` reads these safely (regular files only, inside `logs/`, bounded to 64 KiB per call). An incomplete UTF-8 tail is held back (the cursor stays on a character boundary) while the step runs; a limit below one character's size returns that one character (up to 4 bytes) so the cursor always advances.
- **Timing.** `status` aggregates attempts and time per stage, and counts working-state scans (`advance` also prints `timing.scans`). The full fingerprint and its boundaries are unchanged; no result is cached across stages.
- **`cancel <run>`.** Closes the run and leaves files as they are.
- **Codex stream.** With `--json`, the `-o` file stays the final content, but the stream must end in a successful `turn.completed`. A `turn.failed`, an `error` not followed by a later `turn.completed`, or a stream that stops before it rejects the step (`stream`) even with exit 0. A transient error recovered by a later `turn.completed` is accepted and counted. A stream with no recognised events is not judged (legacy).
- **Grok stream.** Text events are concatenated into the structured answer. An `error` event, a missing terminal `end` event, no text or invalid JSON rejects the step (`stream`/`malformed`), as does a non-zero exit. A whole-JSON stdout (older CLI or `--output-format json`) is parsed as before.
