# Verification evidence (v0.2.2)

**English** · [中文](#中文)

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
