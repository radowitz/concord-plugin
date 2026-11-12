# Verification evidence

**English** · [中文](#中文)

## v0.3.0 verification (2026-11-12)

What was actually run for the model-routing upgrade. Everything below the next heading is the unchanged v0.2.2 evidence.

| # | Evidence | Result |
|---|---|---|
| 1 | Both native suites, `node --test tests/*.test.mjs` (`claude_plugin.test.mjs` + `model-routing.test.mjs`): fake Codex/Grok CLIs, offline docs fixture and injected fetches, temporary git repositories, no network, no real models | 124 tests passed, 0 failed (93 + 31) |
| 2 | `claude plugin validate` on the source plugin, the source marketplace manifest, and a package built with `scripts/package.mjs` | passed (only the optional missing-icon notice) |
| 3 | Package contents built with `scripts/package.mjs` | contains `agents/fable-worker.md`, `agents/opus-worker.md`, `policy/routing.sample.json`, `README.md`, `README.zh-CN.md`, `scripts/lib/routing.mjs`, `scripts/lib/discovery.mjs`; packaged helper reports `0.3.0` |
| 4 | One real bounded fetch of the official model-config page through the discovery code (during development, before the final review fixes) | succeeded in about 1.2 s; aliases `fable`, `sonnet`, `opus`, `haiku` parsed |
| 5 | Read-only native Agent canary on Claude Code 2.1.322, using `concord:fable-worker` without per-call model or effort overrides | returned `CONCORD_FABLE_CANARY_OK`; one Agent completed, no permission denials or substitution warnings; CLI usage reported `claude-fable-5-2`. Agent frontmatter requests `high`; actual effort was not independently observed |
| 6 | Local marketplace update through Claude Code, followed by installed-helper verification | upgraded user-scope `concord@concord-local` from 0.2.2 to 0.3.0; installed helper reports 0.3.0 and the Fable/high default with Opus/xhigh backup; restart required |

Not verified for v0.3.0:

- The Fable canary verifies native agent registration and a minimal response on this machine; it is not an end-to-end coding test. The Opus backup and a real model-unavailability fallback have not been exercised. Per-run helpers still do not observe the actual native model or effort.
- No real Codex/Grok end-to-end workflow was repeated for this upgrade.
- The outcome ledger and the advisory comparison were tested with helper-driven and synthetic runs only; no real timing data exists yet.
- The main-session restriction is a skill instruction plus an advisory `main_session` field; it is not enforced by the helper and was not observed in a live session.

## v0.2.2 (historical, unchanged)

Summary of what was actually run. No raw logs, account identifiers, tokens or machine-specific paths are included. Each item is separate evidence; none of them alone proves the others.

| # | Evidence | Result |
|---|---|---|
| 1 | Native test suite (`node --test tests/claude_plugin.test.mjs`): fake Codex/Grok CLIs, temporary git repositories, no network, no real models | 93 tests passed |
| 2 | `claude plugin validate` on the plugin and on the marketplace manifest | passed (only the optional missing-icon notice) |
| 3 | **Native headless Claude Code run** on a temporary project with real Codex, Grok and `npm test`, started with `/concord:run` | reached `validated` in about 132 s |
| 4 | Real Grok `streaming-json` capture, standalone | succeeded; 212 events, ended with a terminal `end` event; every line parsed by the stream normaliser |
| 5 | Real Codex `exec --json` JSONL capture, standalone | captured and parsed |

## Native run details (item 3)

- Stages: Codex proposal, Grok review, Codex plan, implementation by the **main Claude session** (no Agent subagent was used), actual `npm test`, Codex QA (passed). Run state `validated`; nothing was approved, committed or pushed.
- Working tree: an untracked `.vscode/` file that existed before the run kept identical bytes; the starting `HEAD` was unchanged; the only modified tracked file was the intended one.
- Background tasks: the host issued 6 background Bash attempts. One was denied by the permission system because its command substituted `$PWD`; the other 5 were accepted and were the five labelled stage tasks (`Concord proposal · codex · <run>`, `review · grok`, `plan · codex`, `test-1 · tests`, `qa-1 · codex`). So 5, not 6, stage tasks succeeded. The skill now tells the host to run the helper's literal argv and not to substitute shell variables.
- Output files were followed with the Read tool; the removed `TaskOutput` tool was not used.
- Helper scan counts for the run: 4 fingerprints, 3 tree snapshots (about 0.17 s in total).

## Not verified

- The interactive `/tasks` panel was not opened or clicked; task IDs and output files were checked in the headless run only.
- Live `extend`, `interrupt` and `cancel` against real Codex/Grok, and the native Agent-subagent path, were tested only with fake CLIs.
- Real long waits (tens of minutes) and a real 2-hour background timeout were not exercised.
- Amending a goal mid-run through a real conversation was not exercised. It is best-effort, skill-driven host behaviour: Claude Code supports `UserPromptSubmit` hooks, but this plugin registers none.
- Grok event shapes beyond those seen in the capture follow public documentation; unknown types are counted and ignored.

---

## 中文

### v0.3.0 验证（2026-11-12）

以下为模型路由升级实际运行过的证据；其后的 v0.2.2 记录保持原样。

| # | 证据 | 结果 |
|---|---|---|
| 1 | 两套原生测试 `node --test tests/*.test.mjs`（`claude_plugin.test.mjs` + `model-routing.test.mjs`）：模拟 Codex/Grok、离线文档样本与注入的获取函数、临时仓库，无网络、无真实模型 | 124 个测试通过，0 个失败（93 + 31） |
| 2 | `claude plugin validate`（源码插件、源码 marketplace 清单、`scripts/package.mjs` 构建的安装包） | 通过（仅有可选图标提示） |
| 3 | `scripts/package.mjs` 构建的安装包内容 | 包含 `agents/fable-worker.md`、`agents/opus-worker.md`、`policy/routing.sample.json`、`README.md`、`README.zh-CN.md`、`scripts/lib/routing.mjs`、`scripts/lib/discovery.mjs`；打包后的助手报告版本 `0.3.0` |
| 4 | 通过发现代码对官方 model-config 页面做了一次真实的有界获取（开发期间，最终评审修复之前） | 约 1.2 秒成功；解析出别名 `fable`、`sonnet`、`opus`、`haiku` |
| 5 | Claude Code 2.1.322 上的只读原生 Agent 冒烟测试：调用 `concord:fable-worker`，不传覆盖模型或 effort 的参数 | 返回 `CONCORD_FABLE_CANARY_OK`；一个 Agent 完成，无权限拒绝或模型替换提示，CLI 用量报告包含 `claude-fable-5-2`。代理定义请求 `high`，实际 effort 未被独立观测 |
| 6 | 通过 Claude Code 更新本地 marketplace，并检查已安装的助手 | 用户级 `concord@concord-local` 从 0.2.2 升至 0.3.0；已安装助手报告 0.3.0，默认 Fable/high、备选 Opus/xhigh；重启后生效 |

**v0.3.0 未验证：** Fable 冒烟测试仅证明本机的原生代理注册与最小响应，不是完整编码流程验证；Opus 备选和真实模型不可用时的回退尚未验证。日常任务助手仍无法观测实际使用的原生模型和 effort。本次升级没有重复真实 Codex/Grok 端到端工作流。结果记录与参考性比较只用助手驱动和合成的任务测试过，尚无真实计时数据。主会话限制是技能说明加上参考性的 `main_session` 字段，助手不强制，也未在真实会话中观察。

### v0.2.2（历史记录，未改动）

以下只记录实际运行过的证据，不含原始日志、账号标识、令牌或本机路径。各项证据相互独立，不能互相替代。

| # | 证据 | 结果 |
|---|---|---|
| 1 | 原生测试套件（模拟 Codex/Grok、临时仓库，无网络、无真实模型） | 93 个测试通过 |
| 2 | `claude plugin validate`（插件与 marketplace 清单） | 通过（仅有可选图标提示） |
| 3 | **原生无界面 Claude Code 实跑**：临时项目、真实 Codex、Grok 与 `npm test`，由 `/concord:run` 启动 | 约 132 秒到达 `validated` |
| 4 | 真实 Grok `streaming-json` 单独抓取 | 成功；212 个事件，以 `end` 事件结束，全部被解析 |
| 5 | 真实 Codex `exec --json` 单独抓取 | 已抓取并解析 |

**原生实跑要点：** 阶段为 Codex 提案、Grok 审议、Codex 编排、主 Claude 会话实现（未使用 Agent 子代理）、真实 `npm test`、Codex QA 通过；未审批、未提交、未推送。运行前已有的未跟踪 `.vscode/` 文件字节不变，起始 `HEAD` 不变，仅预期文件被修改。宿主发起 6 次后台 Bash 尝试：1 次因命令里替换了 `$PWD` 被权限系统拒绝，其余 5 次被接受，即 5 个带标签的阶段任务（不是 6 个）。技能现已要求直接使用助手给出的字面 argv，不替换 shell 变量。输出文件用 Read 读取，未使用已移除的 `TaskOutput`。

**未验证：** 交互式 `/tasks` 面板未手动打开；真实 Codex/Grok 下的 `extend`、`interrupt`、`cancel` 以及原生 Agent 子代理路径仅用模拟 CLI 测试；数十分钟的真实长等待与 2 小时后台超时未测；真实对话中途改需求未测（这是尽力而为、由技能驱动的宿主行为：Claude Code 支持 `UserPromptSubmit` 钩子，但本插件未注册任何钩子）。
