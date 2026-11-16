# 更新日志

[English](CHANGELOG.md) · **简体中文**

以下版本对应已发布的 Git 标签。`main` 上的纯文档更新不代表发布了新的插件版本。

## [0.4.0](https://github.com/radowitz/concord-plugin/releases/tag/v0.4.0) — 2026-11-16

Claude 用量受限后，经同意交接给 Codex。发布附件包含独立 marketplace ZIP 与 SHA-256 校验文件。

### 审查修复

- 忽略登录状态前的无关警告；矛盾或未成功的登录结果仍拒绝。
- 交接中的全部 Codex 模型调用（包括只读 QA）固定使用 ChatGPT/OpenAI 登录，并移除继承的 API Key。
- 每个编码步骤开始前都核对已同意的 HEAD、分支、stash 与暂存区，不仅检查第一次。
- 保留字符串错误事件、截断输出及超时 stderr 中的额度证据；保留部分改动，不自动重试。
- 交接模型目录限定 OpenAI/ChatGPT 来源，隐藏标记始终优先。

### 新增

- `paused`：新的开放状态，记录提供方、类别、确切上报内容、待执行步骤和保留的文件。对暂停的任务执行 `advance` 和 `drive` 只返回由人决定的动作，不启动任何进程；不消耗修复轮次，也不重试。
- `quota <run> --step S --revision N --note-file F`：记录原生步骤的确切上限错误。保守、有界地分类为 `usage_window`（用量窗口）与临时的 `rate_limit`（限流）；认证错误、超时、连接错误、格式错误的输出和失败的工作会被拒绝（`not_a_limit`）。需求或代码中的“上限”字样不会被匹配。
- 按任务设置 `on_claude_limit: ask|stop`（`/concord:run --on-claude-limit ask|stop`，默认 `ask`）。`ask` 只是发出询问；两个取值都不是同意。旧任务可以显式交接。
- `takeover <run> --writer-stopped`：生成提案，展示冻结的低/普通/高三档 Codex 模型与 effort 表，以及来源、时间和“过期/未核实”标记。`takeover <run> --proposal ID --decision approve|decline` 记录人的决定，并通过摘要绑定到任务、修订号、需求、任务计划、检出状态（指纹、HEAD、分支、stash、暂存区索引）和确切的模型表。在终端中只有输入 `approve` 才算同意；`--json` 与非终端环境从不读取标准输入。新增 `/concord:takeover` 技能。
- `drive <run>`：在一把锁内依次运行助手阶段（Codex 编码 → 真实检查 → 全新的只读 QA → Codex 修复），直到通过验证、失败、暂停或需要决定。它从不重试、从不代为同意、从不批准。`start` 与 `status` 打印字面的终端命令（助手绝对路径与 `--repo`）。
- 专用的可写 Codex 执行器，仅在同意后使用：`codex exec --sandbox workspace-write`、`approval_policy="never"`、关闭网络、强制 ChatGPT 登录，并移除 `OPENAI_API_KEY`/`CODEX_API_KEY`；API key 登录或无法识别的登录会被拒绝。提案、编排和 QA 仍为只读；Grok 仍不带工具。
- Codex 模型元数据（`codex-models.json`）：只保存 `codex debug models` 的白名单字段，仅在生成提案且缓存超过 24 小时、或执行 `models --refresh` 时刷新；失败时保留上次成功的列表并标记为过期。各档路由依次来自显式的 `--codex-routes` 覆盖、带标注的提供方描述启发式判断、提供方默认模型。`models` 显示本地预览。
- `resume <run> --claude`（把待执行步骤交还 Claude，并结束交接）与 `resume <run> --retry-codex`（用同一条冻结路由重跑未完成的 Codex 步骤）。新增 `limits.role_timeout_s.writer`。

### 行为

- 在交接被批准之前，v0.3.0 的原生路由保持不变。
- Codex 写入未完成（CLI 错误、超时、失败或被截断的事件流、格式错误或 `blocked` 的报告、Codex 额度、登录或模型错误）时暂停并保留改动：不自动重试、不换模型、不消耗修复轮次，步骤不会被标记为完成。写入期间 HEAD、分支、stash 或暂存区索引发生变化会暂停并报告，绝不回滚。
- 修订或重新规划会使交接同意失效；提案与首次写入之间检出状态发生变化时需要新的提案。Codex 接手后，原生的 `--done`、`--failed`、`--use-fallback` 会被拒绝，也不再给出原生动作。
- 有交接记录或暂停记录的任务永远不会计入 Claude 结果记录。
- 同意交接不等于最终批准；`approve` 仍绑定工作区指纹。

### 验证

- 169 项离线确定性测试（原有 124 项 + `tests/handoff.test.mjs` 与 `tests/handoff-writer.test.mjs` 新增 45 项），仅使用模拟 CLI 和临时仓库。没有触发过真实的 Claude 用量上限、真实的 Codex 写入、真实的 Codex 额度错误，也没有用真实账号目录验证过路由。详见[验证记录](docs/verification.md)。

## [0.3.0](https://github.com/radowitz/concord-plugin/releases/tag/v0.3.0) — 2026-11-12

- 中英文 README 分开，默认展示英文。
- 补充机构职责、失败恢复、审批含义和逐版本更新日志。

- 能力档位（`haiku`/`sonnet`/`opus`）与所请求的模型分离。困难任务默认请求 Fable 5.2（high effort），Opus 5.5（xhigh effort）为声明的备选（用户策略，不是基准结论）。低档和普通任务仍请求 `haiku`、`sonnet` 别名。
- 打包代理 `concord:fable-worker`、`concord:opus-worker` 固定完整模型 ID 与 effort，调用时不传 `model` 参数。`--tier` 接受 `haiku|sonnet|opus|fable` 或配置中的候选键；完整模型 ID 会被拒绝。
- 显式且有记录的备选切换：`advance --use-fallback <step> --note-file <错误>`，绝不静默替换。
- 本地路由配置：`models --routing FILE`、`models --reset-routing`。策略与已发布别名快照冻结在每个任务中；旧任务保持原有路由。
- 从官方 model-config 页面发现已发布的 Claude 别名，仅供参考（在被接受的 `start` 且缓存缺失或超过一天时、或 `models --refresh` 时，进行有界 HTTPS 获取；保留上次成功结果、失败退避、`CONCORD_MODEL_DISCOVERY=off`）。`preflight`、`status`、`advance` 不联网。
- 基于已批准的干净原生任务的参考性结果记录（`models --observations`、`models --reset-observations`），从不改变路由。
- 新增测试文件 `tests/model-routing.test.mjs`；用 `node --test tests/*.test.mjs` 运行全部测试。
- 结果比较绑定到确切的请求配置（类型、别名、代理类型、固定模型、effort）；候选键含义改变后，旧样本会被排除并计数。
- `advance` 在任何修改之前拒绝同时使用 `--done`、`--failed`、`--use-fallback`。
- 技能把主会话执行限制为低档、使用策略别名的极小任务（动作中的 `main_session.allowed`）；打包代理、覆盖、备选、更高档位和修复始终使用所请求的代理。
- 验证：见 `docs/verification.md`（124 项离线测试及只读 Fable 原生代理冒烟测试通过；完整原生编码与真实回退尚未验证）。

## [0.2.2](https://github.com/radowitz/concord-plugin/releases/tag/v0.2.2)

### 新增

- Codex/Grok 标准输出、错误输出和规范化事件实时落盘，使用 `/concord:logs` 分段读取。
- Claude Code `/tasks` 可见的带名称后台阶段、阶段耗时和轻量状态查询。
- 外部阶段默认等待 30 分钟、柔性进度通知，以及运行中延长等待时间。
- 需求修订历史与修订号，拒绝过期执行结果；范围变化重新经 Grok 审议与编排。
- 区分中断当前阶段与取消整个任务；修复继承任务风险与模型档位。

### 修复

- 在错误 worktree 发起的变更操作于产生副作用前被拒绝。
- 显式检查在启动目录运行，支持指定检查目录，并提示计划文件可能未被覆盖。
- 即使存在最终输出文件，也拒绝失败或截断的模型事件流；处理已恢复的错误及 UTF-8 日志读取边界。

### 验证

- 93 项确定性测试通过；一次真实 Claude Code 原生无界面任务由主会话编码，完成完整模型、检查和 QA 链路。
- 交互界面、原生 Agent 执行和真实长等待控制尚未验证，详见[验证记录](docs/verification.md)。

## [0.2.1](https://github.com/radowitz/concord-plugin/releases/tag/v0.2.1)

### 新增

- 允许带已暂存、未暂存、未跟踪改动启动，以临时 Git index 保存精确基线；仅在显式 `--require-clean` 时要求干净工作区。
- 根据项目脚本与包管理器信息自动识别检查命令，`--test` 改为可选覆盖。
- 不带参数的 `/concord:run` 使用当前对话中的任务。

### 修复

- 以启动基线而非 `HEAD` 计算任务改动，保留无关的已有工作。
- 区分行为测试与 typecheck/lint/build，跳过不适用的占位、watch 和自动修复脚本。

### 验证

- 49 项确定性测试通过。

## [0.2.0](https://github.com/radowitz/concord-plugin/releases/tag/v0.2.0)

本仓库首次发布的原生 Claude Code 插件。

- 仅使用 Node.js 内置模块，无 Python 后端、守护进程或嵌套 Claude CLI Worker。
- Codex 提案 → Grok 审议 → Codex 依赖编排 → Claude 原生编码 → 项目检查 → 只读 Codex QA → 有限次修复 → 人工审批。
- 持久化任务状态、仓库锁、任务模型档位、完整流程及严格限定范围的快速策略。
- 原生 run/status/resume Skill、本地 marketplace 打包工具和 MIT 开源许可证。
- 此版本要求干净工作区与显式检查配置；v0.2.1 放宽这两项要求。
- 33 项确定性测试通过。

[比较 v0.2.1…v0.2.2](https://github.com/radowitz/concord-plugin/compare/v0.2.1...v0.2.2) · [比较 v0.2.0…v0.2.1](https://github.com/radowitz/concord-plugin/compare/v0.2.0...v0.2.1)
