# Changelog

**English** · [简体中文](CHANGELOG.zh-CN.md)

Versions below correspond to published Git tags. Documentation-only changes on `main` do not imply a new plugin release.

## Unreleased

- Separate English and Chinese READMEs, with English as the default.
- Add architecture roles, failure/recovery and approval explanations, and versioned changelogs.

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
