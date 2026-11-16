# Changelog

**English** · [简体中文](CHANGELOG.zh-CN.md)

Versions below correspond to published Git tags, except the unreleased section at the top. Documentation-only changes on `main` do not imply a new plugin release.

## 0.4.0 — source preview (no tag, ZIP or Release yet)

Consented Claude → Codex handoff after a usage limit. The latest published release is still v0.3.0.

### Review fixes

- Accept a valid ChatGPT login status after warning noise; conflicting or unsuccessful status reports fail closed.
- Force ChatGPT/OpenAI authentication for every Codex inference call during a handoff, including read-only QA; strip inherited API keys.
- Require the approved HEAD, branch, stash and staged index before every coding step, not only the first.
- Retain quota evidence from string error events, truncated streams and timeout stderr; preserve partial work without retries.
- Keep takeover metadata scoped to OpenAI/ChatGPT; hidden entries cannot override their hidden flag.

### Added

- `paused`: a new open run status with the provider, class, exact report, pending step and preserved files. `advance` and `drive` on a paused run return a human-control action and spawn nothing; no repair round is used and nothing is retried.
- `quota <run> --step S --revision N --note-file F`: records the exact limit error of a native step. Conservative, bounded classification into `usage_window` and temporary `rate_limit`; auth errors, timeouts, connection errors, malformed output and failing work are refused (`not_a_limit`). A limit phrase in a request or in code never matches.
- Per-run `on_claude_limit: ask|stop` (`/concord:run --on-claude-limit ask|stop`, default `ask`). `ask` only offers the question; neither value is consent. Older runs can be handed over explicitly.
- `takeover <run> --writer-stopped`: prepares a proposal with a frozen low/normal/high Codex model+effort table, its source, time and stale/unverified marks. `takeover <run> --proposal ID --decision approve|decline` records the human decision, bound by digest to the run, revision, request, task plan, checkout (fingerprint, HEAD, branch, stash, staged index) and the exact table. In a terminal only the typed word `approve` consents; `--json` and non-terminals never read stdin. New `/concord:takeover` skill.
- `drive <run>`: runs helper stages one after another under one lock (Codex writer → real checks → fresh read-only QA → Codex repairs) until validated, failed, paused or a decision is needed. It never retries, never consents and never approves. `start` and `status` print the literal terminal commands (absolute helper path, `--repo`).
- Dedicated writable Codex executor, used only after consent: `codex exec --sandbox workspace-write`, `approval_policy="never"`, network off, ChatGPT login forced, `OPENAI_API_KEY`/`CODEX_API_KEY` removed; an API-key or unknown login is refused. Proposal, plan and QA stay read-only; Grok stays tool-less.
- Codex model metadata (`codex-models.json`): whitelisted fields from `codex debug models`, refreshed only when a proposal is prepared with a cache older than 24 h or by `models --refresh`; last good list kept and marked stale on failure. Tier routes come from an explicit `--codex-routes` override, else a labelled heuristic on provider descriptions, else the provider default. `models` shows a local preview.
- `resume <run> --claude` (give the pending step back to Claude; ends a handoff) and `resume <run> --retry-codex` (run an incomplete Codex step again with the same frozen route). `limits.role_timeout_s.writer`.

### Behaviour

- Until a handoff is approved, v0.3.0 native routing is unchanged.
- An incomplete Codex writer (CLI error, timeout, failed or truncated stream, malformed or `blocked` report, Codex quota, login or model errors) pauses with the edits kept: no automatic retry, no fallback model, no repair round, the step is not marked done. A change of HEAD, branch, stash or the staged index during a writer pauses the run and is reported, never reverted.
- An amendment or re-plan invalidates handoff consent; a checkout that changed between proposal and first writer needs a new proposal. Once Codex owns the work, native `--done`, `--failed` and `--use-fallback` are refused and no native action is exposed.
- Runs with a handoff record or a pause are never added to the Claude outcome ledger.
- Handoff consent is never final approval; `approve` keeps its fingerprint-bound behaviour.

### Verification

- 169 deterministic offline tests (124 existing + 45 new in `tests/handoff.test.mjs` and `tests/handoff-writer.test.mjs`), fake CLIs and temporary repositories only. No real Claude usage limit, real Codex writer, real Codex quota error or real account catalog routing was exercised. See the [verification record](docs/verification.md).

## [0.3.0](https://github.com/radowitz/concord-plugin/releases/tag/v0.3.0) — 2026-11-12

- Separate English and Chinese READMEs, with English as the default.
- Add architecture roles, failure/recovery and approval explanations, and versioned changelogs.

- Capability tiers (`haiku`/`sonnet`/`opus`) are now separate from the requested model. Hard work requests Fable 5.2 at high effort by default, with Opus 5.5 at xhigh effort as the declared fallback (user policy, not a benchmark). Low and normal work still request the `haiku` and `sonnet` aliases.
- Packaged agents `concord:fable-worker` and `concord:opus-worker` pin the full model ID and effort; they are called without a `model` parameter. `--tier` accepts `haiku|sonnet|opus|fable` or a profile candidate key; full model IDs are rejected.
- Explicit, recorded fallback: `advance --use-fallback <step> --note-file <error>`. No silent substitution.
- Local routing profile: `models --routing FILE`, `models --reset-routing`. Policy and published-alias snapshot are frozen into each run; older runs keep their previous routing.
- Advisory discovery of published Claude aliases from the official model-config page (bounded HTTPS at an admitted `start` with a missing/day-old cache, or `models --refresh`; last-good cache, backoff, `CONCORD_MODEL_DISCOVERY=off`). `preflight`, `status` and `advance` stay network-free.
- Advisory outcome ledger from approved clean native runs (`models --observations`, `models --reset-observations`); it never changes routing.
- New test file `tests/model-routing.test.mjs`; run everything with `node --test tests/*.test.mjs`.
- Outcome comparison is bound to the exact requested configuration (kind, alias, agent type, pinned model, effort); samples recorded for a candidate key that now means something else are excluded and counted.
- `advance` rejects combining `--done`, `--failed` and `--use-fallback` before any change.
- Main-session execution is limited by the skill to tiny low-tier tasks on a policy alias (`main_session.allowed` in the action); packaged agents, overrides, fallbacks, harder tiers and repairs always use the requested agent.
- Verification: see `docs/verification.md` (124 offline tests and a successful read-only native Fable worker canary; full native coding and real fallback remain unverified).

## [0.2.2](https://github.com/radowitz/concord-plugin/releases/tag/v0.2.2)

### Added

- Live Codex/Grok stdout, stderr and normalized events, with bounded cursor-based log reads through `/concord:logs`.
- Labeled background stages visible in Claude Code `/tasks`, stage timing and lightweight status.
- Thirty-minute external-stage defaults, soft progress notices and live timeout extension.
- Requirement amendments with revision history, stale-result rejection, and renewed Grok review and planning for scope changes.
- Separate interrupt and cancel controls; repair routing inherits task risk and model tier.

### Fixed

- Reject mutations from the wrong worktree before side effects.
- Run explicit checks in the invocation directory, support an explicit check directory, and warn about uncertain planned-file coverage.
- Reject failed or truncated provider streams even when a final output file exists; handle recovered provider errors and UTF-8 log boundaries.

### Verification

- 93 deterministic tests passed. One real native headless Claude Code run completed the full model/check/QA chain using main-session implementation.
- Interactive UI, native Agent execution and real long-wait controls remain unverified. See the [verification record](docs/verification.md).

## [0.2.1](https://github.com/radowitz/concord-plugin/releases/tag/v0.2.1)

### Added

- Start with staged, unstaged and untracked changes; preserve an exact baseline using a temporary Git index. Clean-only startup becomes opt-in with `--require-clean`.
- Discover project checks from package scripts and package-manager metadata; `--test` becomes optional.
- Bare `/concord:run` uses the task from the current conversation.

### Fixed

- Compare run changes against the starting baseline instead of `HEAD`, preserving unrelated existing work.
- Distinguish tests from typecheck/lint/build checks and skip unsuitable placeholder, watch and autofix scripts.

### Verification

- 49 deterministic tests passed.

## [0.2.0](https://github.com/radowitz/concord-plugin/releases/tag/v0.2.0)

Initial native Claude Code plugin release in this repository.

- Node.js builtins only; no Python backend, daemon or nested Claude CLI workers.
- Codex proposal → Grok review → Codex dependency plan → native Claude implementation → project checks → read-only Codex QA → bounded repair → human approval.
- Durable run state, repository locks, task model tiers, full workflow and narrowly scoped fast policy.
- Native run/status/resume skills, local marketplace packager and MIT license.
- This version required a clean checkout and explicit check configuration; v0.2.1 relaxed those requirements.
- 33 deterministic tests passed.

[Compare v0.2.1…v0.2.2](https://github.com/radowitz/concord-plugin/compare/v0.2.1...v0.2.2) · [Compare v0.2.0…v0.2.1](https://github.com/radowitz/concord-plugin/compare/v0.2.0...v0.2.1)
