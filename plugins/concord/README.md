# 贞观·政事堂 · Concord — Claude Code plugin v0.2.1

**English** · [中文](#中文)

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
```

Helper commands are listed in `node plugins/concord/scripts/concord.mjs --help`. `preflight` is a free check with no inference and no network. `models --refresh` lists the models available to your account through local CLI commands. `approve <run> --decision approve|reject` records your decision. `cancel <run>` stops a run.

## How it works

- **Starting a run.** The checkout does not need to be clean. Staged or unstaged tracked changes and untracked non-ignored files (for example `.vscode/extensions.json`) are recorded as the run's baseline: their exact content is snapshotted as git tree objects using a temporary index copy (your real `.git/index` is never written, nothing is committed, no branch moves). QA diffs and the fast-policy path gate compare against that baseline, not `HEAD`, so pre-existing work is neither audited nor blocks a docs fix. Workers are told to preserve it. Add `--require-clean` (spec `require_clean: true`) to refuse a dirty start; `preflight --require-clean` is the matching strict check. Concord never stashes, resets, commits or overwrites your work. Implementation runs serially in this checkout. v0.2 does not run parallel subagents.
- **Checks.** `--test` is optional. When the spec has no `tests`, `start` reads the nearest `package.json` from the current directory up to the repo root (no workspace scanning): `scripts` in the order `test`, `check`, `typecheck`, `lint`, `build` (placeholders like `echo ... no test specified` and watch scripts are skipped), the package manager from `packageManager` or the lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock[b]`, `package-lock.json`; conflicting lockfiles are not guessed), and runs `<pm> run <script>` as argv in that package directory. Nothing is installed and no shell is used (a `packageManager` shim such as corepack may still fetch its own binary; that is outside Concord). The choice, its source and its kind persist in the run and show in `status`; a typecheck/lint/build gate is reported as such and QA is told it is not a behavioural test. If nothing reliable is found, `start` fails with `no_tests` and the skill asks you. `node scripts/concord.mjs checks --json` previews the choice. Explicit `tests` always win.
- **State.** Run state lives in `$(git rev-parse --git-common-dir)/concord/runs/<id>/`, which is never tracked. There is one lock per repository. A step left running when the helper died is reported as `interrupted`, and only `advance --retry` re-runs it.
- **Validation.** Tests and QA must see the same working-state fingerprint. The fingerprint covers tracked and untracked files, but excludes `.git` and Concord's own state. Missing or failing tests never pass. Blocking QA findings require a repair, and repair rounds are capped (default 2). Malformed plan or QA output is rejected. Any edit after validation invalidates it. A repair that changes nothing stops the run instead of replaying tests and QA.
- **Model routing (吏部选才).** Each task gets the `haiku`, `sonnet` or `opus` alias based on its difficulty and risk. You can override this with `--tier worker=…`. The session passes the alias to the Agent tool's `model`. Work done in the main session is recorded as "inherited, actual model unknown". Codex and Grok use your account default unless you set `--model role=id`. An override is checked against the cached account list, which shows its source and timestamp. Concord never invents model IDs and never picks the "latest" model automatically.
- **Speed.**
  - Planning happens in Concord's own steps, not in the session.
  - No worker processes are started.
  - Each CLI and test run has a wall-clock limit and is killed as a whole process group on timeout or cancel.
  - Model discovery happens only when you ask for it.
  - No hooks run.
  - `--policy fast` combines the proposal and plan, and skips Grok only for a narrow docs-only typo fix (README/CHANGELOG or `docs/` prose). Concord records why. The paths actually changed are checked as well: anything else invalidates the skip and stops the run, leaving files untouched, until `--retry` runs the full review and re-plan.

Details: [skills/run/REFERENCE.md](skills/run/REFERENCE.md). Tests (source repository only): `node --test tests/claude_plugin.test.mjs`, using fake CLIs and temporary repositories.

## Limitations

- This is a functional prototype.
- It runs serially only. Parallel subagents would need separate worktrees, which are not implemented.
- The helper cannot see which exact Claude model served a subagent.
- Login state of `codex` and `grok` is not checked before a run.
- Tests that write files that are not gitignored prevent validation.
- Git submodules and nested repositories are not supported: preflight and start refuse them.
- Linked worktrees share one run store and lock, so only one open run per repository.
- The fingerprint hashes every non-ignored file, so it is slower on very large repositories.

---

## 中文

本插件在**当前 Claude Code 会话**中原生运行 Concord V3 流程：没有 Python 后端，没有守护进程，也不嵌套调用 `claude` CLI。一个只用 Node.js 内置模块的小助手（无 npm、无构建）提供若干短命命令：持久化状态，以只读方式调用 Codex 和 Grok，运行你的真实测试，并告诉会话下一步做什么。**代码由当前会话或其原生 Claude 子代理编写。**

流程：中书省 · Codex 大脑（方案）→ 门下省 · Grok 审议 → 尚书省 · Codex 编排（任务与依赖）→ 六部 · Claude Workers（当前会话或子代理，串行）→ 真实测试（argv，不经 shell）→ 御史台 · Codex QA（只读）→ 有限次 Claude 修复 → 天子决之 · 人工审批。三省六部只是组织隐喻，并非严格的历史对应；每一步同时记录真实的 provider、模型与步骤 ID。**人始终拥有最终决定权**：Concord 不会 commit、push 或部署，审批只记录与已验证工作区指纹绑定的结论。

**安装**：需要 Node ≥ 18、git，以及已安装并登录的 `codex` 和 `grok` CLI。

**从 GitHub 安装**（在 Claude Code 中）：`/plugin marketplace add radowitz/concord-plugin`，然后 `/plugin install concord@concord-plugin`。等价命令行：`claude plugin marketplace add radowitz/concord-plugin` 与 `claude plugin install concord@concord-plugin --scope user`，之后插件会在以后的会话中加载。

本地安装：

```bash
claude --plugin-dir plugins/concord                          # 开发模式
node plugins/concord/scripts/package.mjs --out ~/concord-plugin-dist
claude plugin marketplace add ~/concord-plugin-dist
claude plugin install concord@concord-local
```

**示例**：

```text
/concord:run 为注册表单增加服务端校验
/concord:run                # 不带参数：使用当前对话中的任务（没有任务才询问）
/concord:run --policy fast 修正 README.md 中的错别字
/concord:run --test 'python3 -m pytest -q' 修复任务队列竞态   # 非 Node 项目的可选覆盖
/concord:status
/concord:resume latest
```

**要点**：

- **检查命令**：`--test` 可选。spec 未给 `tests` 时，`start` 从当前目录向上读取最近的 `package.json`（不扫描 workspace）：按 `test`、`check`、`typecheck`、`lint`、`build` 选择脚本（跳过占位脚本与 watch 脚本），包管理器取自 `packageManager` 或锁文件（锁文件冲突时不猜测），在该包目录以 argv 运行 `<pm> run <script>`；不安装、不经 shell。所选命令、来源与类型会记录并显示在 `status`；仅 typecheck/lint/build 会如实标注并告知 QA 这不是行为测试。找不到可靠命令时返回 `no_tests` 并询问用户。`concord.mjs checks --json` 可预览；显式 `tests` 优先。
- **开始与执行**：工作区不必干净。已暂存/未暂存的改动和未被忽略的未跟踪文件（如 `.vscode/extensions.json`）会作为基线保存（用临时 index 副本写成 git tree 对象；不改动真实 index，不提交，不移动分支）。QA diff 与快速策略的路径检查都以该基线为准而非 `HEAD`，原有改动不会被当作本次改动，也不会阻止文档修复。工作者会被告知保留这些改动。显式加 `--require-clean`（spec `require_clean: true`）可拒绝脏工作区；`preflight --require-clean` 为对应严格检查。绝不 stash、reset、commit 或覆盖你的改动。在当前检出目录中串行实现（v0.2 不支持并行子代理）。
- **状态**：保存在 `git-common-dir/concord/runs/<id>/`，不会被 git 跟踪。每个仓库一把锁。中断的步骤只会标记为 `interrupted`，不会自动重跑，需要显式 `advance --retry`。
- **验证**：测试与 QA 必须对应同一个工作区指纹（包含未跟踪文件，不含 `.git` 和自身状态）。没有测试或测试失败都不会通过。阻断性 QA 发现必须修复，修复轮次有上限；格式不合法的计划或 QA 输出会被拒绝；验证之后再改动代码，验证即失效。
- **吏部选才（模型选择）**：按任务难度和风险选择 `haiku`、`sonnet` 或 `opus` 别名，通过 Agent 工具的 `model` 参数传入；主会话自行完成的步骤记录为“继承、实际模型未知”。Codex 和 Grok 默认使用账号默认模型；指定的模型会与带来源和时间戳的缓存账号列表核对；绝不编造模型 ID。
- **快速策略**：仅限 README/CHANGELOG 或 `docs/` 下的文字文件；实际改动的路径也会检查，一旦越界即作废跳过的审议并停止运行（文件保留），`--retry` 后转为完整审议与重新编排。没有任何改动的修复会直接判为失败，不再重复测试和 QA。
- **限制**：功能原型；仅串行；不支持 git 子模块和嵌套仓库（预检与启动时拒绝）；无法得知子代理实际使用的确切模型；不检查 CLI 的登录状态；测试产生未被 gitignore 的文件时无法通过验证。
