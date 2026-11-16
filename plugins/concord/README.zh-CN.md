# 贞观·政事堂 · Concord — Claude Code 插件 v0.4.0

[English](README.md) · **简体中文**

本插件（v0.4.0）在**当前 Claude Code 会话**中原生运行 Concord V3 流程：没有 Python 后端，没有守护进程，也不嵌套调用 `claude` CLI。一个只用 Node.js 内置模块的小助手（无 npm、无构建）提供若干短命命令：持久化状态，以只读方式调用 Codex 和 Grok，运行你的真实测试，并告诉会话下一步做什么。**代码由当前会话或其原生 Claude 子代理编写。** 唯一的例外需要你明确同意：Claude 真的达到用量上限后，可以把任务剩余的编码交给 Codex CLI（见[下文](#claude-用量上限与-codex-交接)）。

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
/concord:run --on-claude-limit stop …   # Claude 用量受限时只暂停，不询问是否交接给 Codex（默认 ask）
/concord:takeover                       # Claude 真的用量受限后：展示提案、询问你，只记录你的决定
```

**要点**：

- **检查命令**：`--test` 可选。spec 未给 `tests` 时，`start` 从当前目录向上读取最近的 `package.json`（不扫描 workspace）：按 `test`、`check`、`typecheck`、`lint`、`build` 选择脚本（跳过占位脚本与 watch 脚本），包管理器取自 `packageManager` 或锁文件（锁文件冲突时不猜测），在该包目录以 argv 运行 `<pm> run <script>`；不安装、不经 shell。所选命令、来源与类型会记录并显示在 `status`；仅 typecheck/lint/build 会如实标注并告知 QA 这不是行为测试。找不到可靠命令时返回 `no_tests` 并询问用户。`concord.mjs checks --json` 可预览；显式 `tests` 优先。
- **开始与执行**：工作区不必干净。已暂存/未暂存的改动和未被忽略的未跟踪文件（如 `.vscode/extensions.json`）会作为基线保存（用临时 index 副本写成 git tree 对象；不改动真实 index，不提交，不移动分支）。QA diff 与快速策略的路径检查都以该基线为准而非 `HEAD`，无关的原有改动不会被当作本次改动，也不会阻止文档修复；但若原有缺陷妨碍所请求的结果，QA 仍可将其列为问题。工作者会被告知保留这些改动。显式加 `--require-clean`（spec `require_clean: true`）可拒绝脏工作区；`preflight --require-clean` 为对应严格检查。绝不 stash、reset、commit 或覆盖你的改动。在当前检出目录中串行实现（v0.2 不支持并行子代理）。
- **绑定工作树**：同一仓库的各 worktree 共用一个任务库，因此任务记住其启动时的检出目录（`run.repo`）。`advance`、`resume`、`amend`、`extend`、`approve`、`cancel` 在其他 worktree 上会在加锁、写入、发信号或调用模型之前以 `wrong_worktree` 拒绝，并指明正确的 `--repo`。`status`、`show`、`list`、`logs` 仍可在任何位置只读使用；对外部任务，`status` 会说明“工作区状态不可用”，而不是拿错误的文件比对。
- **检查目录**：显式检查在启动时所在目录运行，与该目录下自动检测的检查一致。spec 的 `tests_cwd`（仓库内已存在的相对目录，不得含 `..`）让宿主即使在子包中也能在根目录运行根目录命令。目录会记录到任务与每个测试步骤并显示在 `status`。v0.2.2 之前保存的任务保留“仓库根目录”回退并明确标注。
- **检查覆盖**：规划之后，Concord 将计划文件与检查所在目录及 `package.json` 边界比对，当文件在目录之外、或位于无法证明脚本会覆盖的嵌套包时，保存保守的 `check_coverage` 警告，并在实现前和最终总结中显示。它不会额外运行检查、增加提问，也不声称脚本元数据无法证明的覆盖。
- **任务中途修订**：`amend <run> --spec FILE`，内容 `{"kind":"clarify"|"scope","text":"…"}`。它提升修订号、保留历史、使验证失效，并保持基线和所有改动不变。`clarify` 保留计划；`scope` 会使此前的 Grok 批准失效：先由 Grok 审议修订后的需求与当前改动，再重新规划（已完成任务会告知规划者，不重做提案）。之后每个 Codex/Grok/QA 提示和工作者动作都带有生效的需求；`--done --revision N` 会拒绝过期结果。助手阶段运行中拒绝修订（可等待，或用 `interrupt <run>` 中断当前阶段并保持任务开放；`cancel` 会永久关闭任务）；原生写入者可能仍在编辑时，必须用 `--writer-stopped` 声明已停止才能修订，助手无法终止原生 Agent。这是尽力而为、由技能驱动的：Claude Code 支持 `UserPromptSubmit` 钩子，但本插件未注册任何钩子，不会自动拦截聊天；只有技能指示宿主、且宿主判断你的消息修改了进行中的任务时才会调用。
- **等待与后台任务**：Codex/Grok 每步默认 1800 秒（`limits.review_timeout_s`，`0` 为无助手期限，可用 `limits.role_timeout_s` 按角色设置；此前 Grok 的 120/60 秒只是一次性的审议预算，不是策略）。超时会终止进程组并报告为超时，绝不当作 Grok 的结论；不更换模型，也不跳过审议。每 30 秒（`CONCORD_HEARTBEAT_MS`）的提示只显示已用时间和最近输出。`extend <run> --review-timeout S` 调整运行中助手的期限（无守护进程：助手的计时器重读一个小控制文件）。技能将每个阶段作为后台 Bash 任务运行 `advance --one-step`，设置合适的 `timeout` 与标明阶段的描述，使 `/tasks` 显示 `Concord review · grok · <run>`。Codex/Grok 仍是外部 CLI，不是原生 Claude 代理；Bash 输出文件包含进度行，其余内容见 `logs`。无后台 Bash 时回退到前台，此时宿主 10 分钟的 Bash 上限可能截断更长的阶段。
- **日志与事件**：Codex 使用 `--json`（`-o` 文件仍是权威的最终消息，但 `turn.failed`、未恢复的错误或被截断的流都会拒绝该步骤；之后由 `turn.completed` 恢复的临时错误可接受）；Grok 使用 `--output-format streaming-json`，仍然无工具、plan 模式、禁用子代理，其文本事件被解析为结构化结果（`error` 事件、缺少 `end` 事件、无效 JSON 或非零退出码均会拒绝该步骤；不支持该格式的旧版 Grok 使用 `json`）。原始字节实时写入 `logs/`，并记录规范化事件、pid、最近输出时间、字节与事件计数。思考类事件只保留在原始日志中，不作为进度显示。`logs <run> [--step ID] [--stream stdout|stderr|events] [--offset N] [--limit N]` 在助手持锁期间也可安全读取（仅限任务 logs 目录内的普通文件，每次最多 64 KiB，用 `next_offset` 作字节游标）。不会编造百分比或模型用量。
- **耗时统计**：`status` 显示各阶段次数与耗时、任务时间线和工作区扫描次数；`status --light` 在阶段运行期间跳过完整的工作区哈希。`approve`、测试与 QA 始终使用完整指纹。
- **修复路由**：修复使用相关任务中最高的档位（至少 sonnet；高风险或风险关键词为困难档，默认即 Fable 5.2/high）；`--tier repair=…` 仍然优先。
- **状态**：保存在 `git-common-dir/concord/runs/<id>/`，不会被 git 跟踪。每个仓库一把锁。中断的步骤只会标记为 `interrupted`，不会自动重跑，需要显式 `advance --retry`。
- **验证**：测试与 QA 必须对应同一个工作区指纹（包含未跟踪文件，不含 `.git` 和自身状态）。没有测试或测试失败都不会通过。阻断性 QA 发现必须修复，修复轮次有上限；格式不合法的计划或 QA 输出会被拒绝；验证之后再改动代码，验证即失效。
- **吏部选才（模型选择）**：按任务难度和风险确定能力档位：低 → `haiku` 别名，普通 → `sonnet` 别名，困难 → Fable 5.2/high，Opus 5.5/xhigh 为声明的备选（用户偏好，见下文[模型路由](#模型路由)）；主会话自行完成的步骤记录为“继承、实际模型未知”。Codex 和 Grok 默认使用账号默认模型；指定的模型会与带来源和时间戳的缓存账号列表核对；绝不编造模型 ID。
- **快速策略**：仅限 README/CHANGELOG 或 `docs/` 下的文字文件；实际改动的路径也会检查，一旦越界即作废跳过的审议并停止运行（文件保留），`--retry` 后转为完整审议与重新编排。没有任何改动的修复会直接判为失败，不再重复测试和 QA。
- **交接功能的限制（0.4.0）**：Codex 交接只用模拟 CLI 验证过；没有触发过真实的 Claude 用量上限、真实的 Codex 写入、真实的 Codex 额度错误，也没有用真实的 `codex debug models` 验证过路由。上限与 Codex 错误的识别是对文本的尽力匹配，可能漏掉某些措辞（终端里的 `takeover` 不依赖任何机器上报）。交互式同意只通过行解析器测试，未在真实终端中测试。交接无法核实原生 Claude 写入者已停止，`--writer-stopped` 只是确认；`workspace-write` 沙箱与写入前后的 Git 比较只能减少、不能排除模型命令的意外副作用。模型路由是基于提供方描述的启发式判断，描述信息不足时会使用提供方默认模型（不传 `--model`），也不能证明你的套餐包含某个模型。
- **验证与限制**：0.4.0 源码共 169 项离线确定性测试通过（v0.3.0 为 124 项）；只读 Fable 原生代理冒烟测试通过，并有一次真实原生无界面任务完成完整模型链路（由主 Claude 会话编码）；已有文件和 HEAD 不变。交互面板、原生 Agent 编码及真实长等待控制仍未验证，完整记录位于源码仓库 `docs/verification.md`。需求修订由宿主按 Skill 调用 `amend`，本插件未注册钩子，不会自动拦截每条聊天。`extend` 与提示仅在助手存活期间有效，无守护进程；关闭助手超时不能绕过宿主限制。不支持子模块或嵌套仓库，无法观测子代理确切模型，不预检 CLI 登录，测试产生未忽略文件时无法验证。

## Claude 用量上限与 Codex 交接

[v0.4.0](https://github.com/radowitz/concord-plugin/releases/tag/v0.4.0) 新增。当 Claude 真的达到用量上限时，Concord 暂停任务并**询问**是否由 Codex CLI 完成剩余的任务与修复。它使用你已有的、以 ChatGPT 登录的 Codex CLI：不接 API、不用 API key、没有 Python 守护进程、不嵌套 Claude worker、不注册钩子。没有你的明确决定就不会切换；在此之前 v0.3.0 的原生路由（Fable 5.2/high，Opus 5.5/xhigh 备选）保持不变。

交接后保持不变的内容：同一个任务、计划与任务依赖、已完成的子任务、需求及全部修订、脏工作区基线、阶段历史、测试命令，以及所有已修改的文件（写到一半的文件会作为上下文交给 Codex）。不会 stash、reset、删除、commit、merge、push 或部署。

**worker 或 Agent 调用触发上限，而会话仍可工作。** run 技能上报确切错误（`quota`），助手分类并暂停，会话用提问界面询问你、展示提案，并只传递你的回答：

```text
H quota <run> --step task-T2 --revision 1 --note-file <确切错误>        # → paused；用量上限 + ask → await_switch
H takeover <run> --writer-stopped --json                              # 提案与冻结的模型表；不构成同意
H takeover <run> --proposal hp-… --decision approve --writer-stopped  # 你的决定，绑定到该提案
H advance <run> --one-step                                            # Codex 编码、检查、QA、修复都是助手阶段
```

**Claude 会话本身额度耗尽。** 它可能无法运行任何技能，Concord 也无法让提示自动弹出。`start` 和 `status` 会打印可直接复制的命令（使用已安装助手的绝对路径），请在普通终端运行：

```bash
node /abs/path/to/concord/scripts/concord.mjs takeover <run-id> --writer-stopped --drive --repo /abs/path/to/checkout
node /abs/path/to/concord/scripts/concord.mjs drive <run-id> --repo /abs/path/to/checkout
node /abs/path/to/concord/scripts/concord.mjs status <run-id> --repo /abs/path/to/checkout
```

`takeover` 打印提案，然后等待你输入 `approve` 或 `decline`。空行、其他任何输入、输入被关闭、`--json` 或非终端环境都不会记录同意。之后 `drive` 在该终端里依次运行 Codex 编码 → 你的真实检查 → 全新的只读 Codex QA → Codex 修复，直到任务通过验证、失败或暂停。没有守护进程：关闭终端即停止，被中断的写入不会自行重启。`drive` 从不替你批准；对已验证状态的 `approve` 仍是你单独做出的决定。

- **按任务设置：`--on-claude-limit ask|stop`**（spec `on_claude_limit`，默认 `ask`）。`ask` 在用量上限后发出询问；`stop` 只暂停、不询问。两者都不是同意。旧版本启动的任务可以显式交接，无需重置。
- **什么算上限。** 只有上报内容中某一行本身就是用量或订阅上限的陈述（`usage_window`），或 429 之类的限流陈述（`rate_limit`）。临时限流只暂停并给出等待/恢复指引，不提供切换。认证错误、超时、连接错误、格式错误的输出和测试失败都会被拒绝，仍按普通失败处理。需求或代码中出现“用量上限”字样不会触发任何动作。你也可以在终端里不带任何机器上报直接请求交接；它会被记录为你的请求（`source: user` / `human_report`），而不是已核实的上限。
- **同意。** 一次决定覆盖本任务在当前修订号下剩余的任务与修复编码，且只使用所展示的模型表。它绑定到提案 ID 与摘要（任务、修订号、需求、计划、检出指纹、HEAD、分支、stash、暂存区索引、模型与 effort）：其中任何一项变化，批准都会被拒绝，需要重新生成提案。新的修订或重新规划会使同意失效。拒绝后任务保持开放；被拒绝的提案永远不能再被批准。
- **`--writer-stopped`。** 必需。助手无法看到、核实或停止原生 Claude 写入者，也绝不向 Claude 会话发送信号；该参数只是你对“没有写入者仍在编辑”的确认。
- **模型。** 生成提案时 Concord 读取 `codex debug models`（缓存 24 小时；只保留白名单字段，绝不保存 base instructions），并为每个档位展示一条路由：低档 → 提供方描述为快速/高效的模型，普通 → 当前主力模型，高档 → 前沿/高要求模型，effort 取模型声明支持的值（`low`/`medium`/`high`；`xhigh` 仅在你指定时使用）。描述无法提供依据时不传 `--model`，提案会如实说明。这是基于提供方描述的启发式判断，不是基准测试，不按版本或名称排序，也不能证明你的账号可以使用某个模型。可用 `--codex-routes low=<模型>[@effort],normal=…,high=…` 覆盖（会对照列表校验）。模型表在本次交接中冻结；之后发布的新模型不会改变它。列表过期或缺失时，会在你决定之前如实标明。
- **写入者。** `codex exec --sandbox workspace-write`，approvals 为 `never`、关闭网络并强制 ChatGPT 登录；其环境中会移除 `OPENAI_API_KEY`/`CODEX_API_KEY`，API key 登录会被拒绝。不会修改你保存的 Codex 配置与登录。提案、编排和 QA 仍为只读，Grok 仍然不带工具。
- **Codex 无法完成时。** CLI 错误、超时、失败或被截断的事件流、格式错误或 `blocked` 的报告、Codex 自己的用量上限、登录问题或模型不可用，都会暂停任务并保留改动。不重试、不换模型、不消耗修复轮次。`resume <run> --retry-codex` 在你要求时重跑同一步骤；`resume <run> --claude` 把该步骤交还 Claude（例如 Claude 限额恢复之后）。
- **Git 状态。** 每次写入前后都会比较 HEAD、分支、stash 和暂存区索引；出现变化就暂停并报告，绝不回滚。Codex 的沙箱限制的是模型执行的命令，并不是操作系统级的保证。
- **记录。** `status` 显示每个子任务由谁编写、冻结的模型表及其来源和时间、切换原因和每一次暂停。交接过或暂停过的任务永远不会计入 Claude 的结果记录。

## 模型路由

下文 `H` 指 `node <插件目录>/scripts/concord.mjs`（在 Claude Code 内为 `node "${CLAUDE_PLUGIN_ROOT}/scripts/concord.mjs"`）。

三件事严格分开：任务的**能力档位**（`haiku` = 低，`sonnet` = 普通，`opus` = 困难；由难度和风险计算，绝不按版本号排序）、为它**请求的候选模型**，以及**实际运行的模型**（Concord 无法观测，也绝不记录为已知）。

| 档位 | 默认请求 | 请求方式 |
|---|---|---|
| `haiku`（低） | 别名 `haiku` | Agent 工具 `model: "haiku"` |
| `sonnet`（普通） | 别名 `sonnet` | Agent 工具 `model: "sonnet"` |
| `opus`（困难、高风险、风险关键词） | `fable-5.2-high` = `claude-fable-5-2`，effort `high`；声明的备选 `opus-5.5-xhigh` = `claude-opus-5-5`，effort `xhigh` | 随插件打包的代理 `concord:fable-worker` / `concord:opus-worker`，调用时**不传** `model` 参数 |

- **为什么用打包代理。** Agent 工具的单次 `model` 参数只接受 `haiku`、`sonnet`、`opus`、`fable`；完整模型 ID 需要写在代理的 frontmatter 中；effort 也可按次指定，Concord 将两者一起固定在 frontmatter 中。因此精确版本固定在 `agents/fable-worker.md` 和 `agents/opus-worker.md` 中。固定的 ID 不会随新模型发布而变化；别名则跟随 Claude Code 当前的映射。
- **默认值是用户偏好。** “困难任务优先 Fable 5.2/high，而不是 Opus 5.5/xhigh”作为内置策略保存（同时见 `policy/routing.sample.json`），并复制进每个任务。这不是基准测试结论。
- **备选必须显式切换。** 如果宿主无法运行所请求的代理、模型或 effort（不可用、被拒绝、Claude Code 版本过旧），会话先报告确切错误，再执行动作里的 `fallback.switch` 命令（`advance --use-fallback <step> --note-file <错误>`）。切换连同原因一起记录，该步骤绝不会被说成用了首选模型。代码、测试或 QA 失败不是切换理由。显式 `--tier` 选择没有备选，会直接明确失败。
- **主会话执行。** 只有低档、使用策略普通别名的极小任务，会话才可以自己完成（动作中的 `main_session.allowed`）。打包代理、显式 `--tier` 选择、备选、普通/困难任务和修复都必须交给所请求的代理。这是技能规则，助手无法强制；报告为 `--executor main` 的步骤记录为“继承/未知”。
- **按任务冻结。** 策略和已发布别名快照在启动时写入任务。之后的 `models --refresh`、`--routing`、`--reset-routing` 只影响新任务。旧版本保存的任务仍按档位请求 `haiku`/`sonnet`/`opus` 别名。

自动发现（仅供参考）：

```text
H models --refresh        # 同时立即重新读取已发布的别名列表
H models                  # 策略、候选、就绪情况、来源与时间
```

任务被接受后（规格、仓库和未结束任务检查之后），若已发布别名列表缺失或超过一天，会从 `https://code.claude.com/docs/en/model-config.md` 获取一次（一次 HTTPS GET，≤ 3 秒，≤ 512 KiB，只跟随到官方域名的重定向）。失败时保留上次成功的列表并退避。`preflight`、`status`、`advance`、`--help` 从不联网；`CONCORD_MODEL_DISCOVERY=off` 可完全关闭获取。该列表是公开文档，不是你账号的模型列表，也不会自行改变路由：新发布的系列只显示为“仅候选”，需要 Claude Code 支持并在配置中显式写明才会使用。

单次试用某个模型：

```text
/concord:run --tier worker=fable 修复任务队列里的竞态        # 所有任务使用 Fable 5.2/high
/concord:run --tier worker=opus --tier repair=opus …        # Opus 5.5/xhigh
/concord:run --tier worker=fable-alias …                    # `fable` 别名，版本由 Claude Code 决定
```

`--tier` 接受 `haiku`、`sonnet`、`opus`、`fable` 或 `H models` 列出的候选键。完整模型 ID 和 `inherit` 会被拒绝。

本地策略（按用户保存在缓存目录，跨会话保留）：

```text
cp <插件目录>/policy/routing.sample.json my-routing.json   # 按需修改
H models --routing my-routing.json                         # 校验并保存；无效则不保存
H models --reset-routing                                   # 恢复内置默认
```

配置是叠加在默认值之上的。例如让困难任务首选 Opus、Fable 作为备选：

```json
{"name": "opus-first", "routes": {"high": {"primary": "opus-5.5-xhigh", "fallback": "fable-5.2-high"}}}
```

候选只能是 `{"alias": "haiku|sonnet|opus|fable", "tiers": [...]}` 或 `{"agent": "<打包代理>", "tiers": [...]}`；Haiku 或 Sonnet 候选不能被设为更高档位可用，完整模型 ID 只能来自打包代理。四个文档别名之外的已发布别名还需要 `"host_compatible": true`。

结果记录（仅供参考）：

```text
H models --observations         # 样本与分组比较
H models --reset-observations   # 删除记录
```

你批准任务时，只有“干净”的任务才会在本地记一条样本：已验证；每个子任务都由原生子代理、以同一个请求候选执行一次；没有修复、修订、备选切换、失败、中断或主会话执行。样本包含实测的指派周转时间（动作发出 → 记录 `--done`；同一步骤被发出两次则丢弃）和分组（档位/难度/风险）。只有某候选与该档位基线在同一分组各有 ≥ 3 条样本、且中位数快 ≥ 20% 时，才标记为 “advisory_faster”。每条样本绑定到确切的请求（别名或打包代理、固定模型、effort）：如果之后配置把同一个候选键指向别的东西，旧样本会被排除并计入 `obsolete_identity`，绝不记到新含义名下。它从不改变路由：修改配置是提升模型的唯一途径。它衡量的是你自己任务中“请求的候选”，不是受控基准测试；别名样本也不能说明实际运行的版本。

限制：Concord 无法在调用 Agent 之前确认你的账号、提供方或 Claude Code 版本支持固定的模型或 effort；周转时间包含会话自身的开销；别名解析只读取文档中的别名表。

测试（仅源码仓库）：`node --test tests/*.test.mjs`（运行 `claude_plugin`、`model-routing`、`handoff`、`handoff-writer`；离线）。
