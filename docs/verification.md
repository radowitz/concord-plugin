# Verification evidence

**English** · [中文](#中文)

## 0.4.0 (unreleased) verification — consented Claude → Codex handoff

What was actually run for the handoff. Everything is mocked: fake `codex`/`grok` CLIs, a fake model catalog with invented slugs, temporary git repositories. Nothing below is evidence about real provider behaviour.

| # | Evidence | Result |
|---|---|---|
| 1 | All four test files, `node --test tests/*.test.mjs` (`claude_plugin`, `model-routing`, `handoff`, `handoff-writer`): offline, no network, no real models | 169 tests passed, 0 failed (124 existing + 45 new) |
| 2 | Package built with `scripts/package.mjs` (inside the test suite) | contains `scripts/lib/handoff.mjs`, `scripts/lib/codex-routing.mjs`, `skills/takeover/SKILL.md`; packaged helper reports `0.4.0` and lists `takeover` in `--help` |
| 3 | Local `codex exec --help` / `codex login --help` of codex-cli 0.169.0 (help screens only, no model call) | the flags the writer uses exist: `--json`, `--sandbox workspace-write`, `--ephemeral`, `--color`, `-C`, `-c key=value`, `--output-schema`, `-o`, `--model`; `login status` exists |

Mocked coverage in the 45 new tests:

- **Limit classification:** usage-window and rate-limit statements as whole lines; auth, timeout, connection, malformed-output and failing-test texts refused; limit phrases inside requests, sentences and code not matched; 40-line / 400-character bound.
- **Pause:** `ask` vs `stop`; rate limit without an offer; `advance`/`drive` on a paused run spawn nothing; `--done`, `--failed`, `--retry` refused; partial edits kept; step, revision, worktree and lock guards before any write or CLI call.
- **Consent:** a proposal is not consent; non-terminal and `--json` never read stdin (stdin carrying `approve` is ignored); only the literal words count (line parser, EOF, empty, `yes`); `--writer-stopped` and a proposal id required; decline keeps the run open and can never be approved; approval refused after a change to working files, staged index, HEAD, model table, task plan or revision; checkout change between consent and the first writer; immutable HEAD/branch/stash/index drift before every later writer; human request without a machine report; legacy run; non-recoverable states (review rejection, spent repair budget, dead helper stage).
- **Login and billing:** API-key, missing and unrecognised `codex login status` answers refused; `OPENAI_API_KEY`/`CODEX_API_KEY` absent from every handoff call; exact writer argv (workspace-write, approvals never, network off, ChatGPT forced, no bypass flags) and ChatGPT-only QA credentials while retaining its read-only sandbox; harmless login warnings accepted, conflicting/nonzero login results refused; login change after consent.
- **Models:** metadata whitelist (no base instructions), explicit OpenAI/ChatGPT provider scope, hidden flag precedence, hidden/review/older entries, priority tiebreak independent of names, effort only when declared, provider-default fallback, overrides validated against the list, 24 h TTL, last-good cache and stale/unverified display.
- **Writer and drive:** remaining DAG → real check → Codex repair → QA → second repair → validated → separate human approval; repair budget and no-op repair guards; ten kinds of incomplete writer (exit, `turn.failed`, truncated, unrecovered error, missing final message, no events, non-JSON, wrong shape, wrong status, `blocked`) pausing with partial edits; Codex quota, rate limit, auth and model errors with no loop and no other model; Git index, HEAD and stash tampering; frozen routes after a new model appears; re-consent after clarify and scope amendments; late native reports refused; `--one-step`, `--max-steps`, one lock for the whole drive; live logs; interrupt, helper timeout, dead helper and cancel; `resume --claude`; no outcome-ledger sample; no commit, no index change, no stash.

Not verified for 0.4.0:

- No real Claude usage limit was triggered inside a Concord run for this verification. The limit patterns are matches on message text chosen from known wordings; a real message with another wording is classified `unknown` and refused (the terminal `takeover` still works without a machine report).
- No real Codex writer run was performed. Writable sandbox behaviour, model execution and live provider-error recovery remain unverified. Local CLI help, the account model catalog and ChatGPT login-status parsing (including a warning before the status line) were checked without inference.
- Tier routing was not run against a real account catalog inside the test suite (the committed fixtures use invented slugs); whether a selected model is usable by an account is never proven by the helper.
- Interactive terminal consent was tested through its line reader with in-memory streams, not through a real TTY. The skill-driven question UI in a live Claude Code session was not exercised.
- The trust boundaries are unchanged by testing: the helper cannot verify that a native writer stopped, cannot tell a human from a session passing `--decision approve`, and compares Git state before/after a writer rather than preventing changes.
- User-scope `concord@concord-local` was updated from 0.3.0 to 0.4.0 and the installed assets were checked against source. Restart Claude Code to load the update. No live handoff or release was performed.

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

### 0.4.0（未发布）验证 — 经同意的 Claude → Codex 交接

以下全部为模拟：模拟的 `codex`/`grok` CLI、使用虚构模型名的模拟目录、临时 git 仓库。这些都不能说明真实提供方的行为。

| # | 证据 | 结果 |
|---|---|---|
| 1 | 四套测试 `node --test tests/*.test.mjs`（`claude_plugin`、`model-routing`、`handoff`、`handoff-writer`）：离线、无网络、无真实模型 | 169 个测试通过，0 个失败（原有 124 + 新增 45） |
| 2 | `scripts/package.mjs` 构建的安装包（在测试中） | 包含 `scripts/lib/handoff.mjs`、`scripts/lib/codex-routing.mjs`、`skills/takeover/SKILL.md`；打包后的助手报告 `0.4.0`，`--help` 列出 `takeover` |
| 3 | 本机 codex-cli 0.169.0 的 `codex exec --help` / `codex login --help`（只读帮助页，不调用模型） | 写入者用到的参数均存在：`--json`、`--sandbox workspace-write`、`--ephemeral`、`--color`、`-C`、`-c key=value`、`--output-schema`、`-o`、`--model`；`login status` 存在 |

45 个新测试的模拟覆盖范围：

- **上限分类：** 整行的用量/限流陈述；拒绝认证、超时、连接、格式错误与测试失败文本；需求、句子和代码中的字样不匹配；40 行/400 字符上限。
- **暂停：** `ask` 与 `stop`；限流不询问；暂停时 `advance`/`drive` 不启动进程；拒绝 `--done`、`--failed`、`--retry`；保留半成品改动；在任何写入或 CLI 调用之前检查步骤、修订号、worktree 和锁。
- **同意：** 提案不等于同意；非终端与 `--json` 不读标准输入（标准输入里带 `approve` 也被忽略）；只有字面单词有效（行解析、EOF、空行、`yes`）；必须有 `--writer-stopped` 和提案 ID；拒绝后任务保持开放且该提案不能再批准；工作文件、暂存区索引、HEAD、模型表、任务计划或修订号变化后拒绝批准；同意后首次写入前工作文件变化，以及每次写入前 HEAD、分支、stash 和暂存区变化；无机器上报的人工请求；旧任务；不可恢复的状态（审议否决、修复轮次用尽、助手阶段中途死亡）。
- **登录与计费：** 拒绝 API key、未登录和无法识别的 `codex login status` 结果；所有交接调用的环境中都没有 `OPENAI_API_KEY`/`CODEX_API_KEY`；写入者的确切 argv（workspace-write、approvals never、关闭网络、强制 ChatGPT、无绕过参数）与未改动的只读 QA argv；同意后登录方式变化。
- **模型：** 元数据白名单（不含 base instructions）、隐藏/评审/旧模型、与名称无关的优先级、仅使用已声明的 effort、提供方默认回退、对照列表校验覆盖、24 小时缓存、保留上次成功结果并标注过期/未核实。
- **写入与 drive：** 剩余任务 → 真实检查 → Codex 修复 → QA → 再次修复 → 通过验证 → 单独的人工批准；修复上限与无改动修复；十种未完成的写入（退出码、`turn.failed`、截断、未恢复的错误、缺少最终消息、没有事件、非 JSON、结构错误、状态错误、`blocked`）均暂停并保留半成品；Codex 额度、限流、认证和模型错误，且不循环、不换模型；Git 索引、HEAD、stash 被改动；新模型出现后路由仍冻结；clarify 与 scope 修订后重新同意；拒绝迟到的原生上报；`--one-step`、`--max-steps`、整个 drive 一把锁；实时日志；中断、助手超时、助手死亡与取消；`resume --claude`；不产生结果记录样本；无提交、无索引变化、无 stash。

**0.4.0 未验证：**

- 没有触发过真实的 Claude 用量上限。上限识别是对已知措辞的文本匹配，其他措辞会被归为 `unknown` 并拒绝（终端 `takeover` 不依赖机器上报）。
- 没有运行过真实的 Codex 写入；写入沙箱、真实模型执行与真实额度错误恢复仍未验证。已在不调用模型推理的情况下检查本地 CLI 帮助、账号模型目录和 ChatGPT 登录状态解析（包含状态行之前的警告）。
- 测试中没有用真实账号目录验证过档位路由（提交的样本使用虚构模型名）；助手永远无法证明某个账号可以使用所选模型。
- 交互式终端同意只通过内存流测试了行读取，未在真实 TTY 中测试；真实 Claude Code 会话中由技能驱动的提问界面未验证。
- 信任边界不因测试而改变：助手无法核实原生写入者已停止，无法区分是人还是会话传入了 `--decision approve`，对 Git 状态只做写入前后的比较而不是阻止。
- 用户级 `concord@concord-local` 已从 0.3.0 更新至 0.4.0，并核对安装内容与源码一致；重启 Claude Code 后加载。没有运行真实接管或发布新版本。

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
