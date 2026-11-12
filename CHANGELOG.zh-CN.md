# 更新日志

[English](CHANGELOG.md) · **简体中文**

以下版本对应已发布的 Git 标签。`main` 上的纯文档更新不代表发布了新的插件版本。

## 尚未发布

- 中英文 README 分开，默认展示英文。
- 补充机构职责、失败恢复、审批含义和逐版本更新日志。

## 0.3.0（尚未发布）

源码及本地安装版本，尚未发布 Git 标签或 GitHub Release。

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
