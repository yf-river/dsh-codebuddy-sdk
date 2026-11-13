# CodeBuddy 缓存与费用核查（2026-11-13）

结论：已复现并修复一个会破坏历史前缀、同时丢失工具结果正文的插件兼容问题。CodeBuddy SDK 默认将超过 50KB 的工具结果写入 SDK 会话目录，只向模型发送前 2048 字节预览；插件每次生成创建新的 SDK 会话，重放同一工具结果会产生不同文件路径。不能把这类缓存停滞归因为服务端 190K 上限。

本文区分已验证修复、历史收益上界和未完成事项。本轮只执行本地分析、测试和文档更新，未执行 commit、push、安装或服务重启。11:14 的只读复核发现，工作区 HEAD 已包含修复提交 `ca1d60f`，web profile 已指向修复包，安装的 runtime 文件包含该修复；这些现场变化不是本轮执行的动作。仍需用安装后的真实业务请求验收。

## 可复现的证据

真实会话 `session-2e60aac2-b2f3-439a-99ca-80348fd2f66a` 的 `tool/result` seq 1069，调用 ID 为 `call_00_ET_u0jZ5HtNjViaQ3Qz0YPD1521`，文本大小为 64,109 字节。前一次成功请求读取缓存 188,160 token，此结果进入历史后读取达到 189,440，并随后长期停在该附近。

使用安装版本的 `Session.create()` / `deriveMessages()` 重建请求历史，DSH 请求的旧消息只追加、不改写。在隔离网络命名空间中，把同一历史送入官方 SDK，由本地 HTTP fixture 捕获真实出站请求。修复前，此工具结果变成 `<persisted-output>`：文件路径中含每次不同的 SDK 会话 UUID。修复后，连续样本分别有 296/296、298/298 条旧消息正文完全一致，工具声明也一致，64,109 字节正文完整传递。比较时仅排除 SDK 的 `conversationRequestId` 请求追踪字段。

SDK 2.172.1 的 `ToolResultBlobService.shouldExternalize()` 默认阈值为 50KB，由 `CODEBUDDY_TOOL_RESULT_THRESHOLD_KB` 读取；`externalize()` 将预览限制为 2048 字节，并调用 `getSessionToolResultDir()` 把会话 ID 写入模型可见路径。插件 `src/worker.ts` 每次用 `randomUUID()` 创建 SDK 会话。这形成了明确、可重现的前缀变化链。

其他日志有相同触发条件，不能仅凭相关性视为逐个完成了出站因果复现：

| 会话 | 首个超限结果 seq | UTF-8 字节数 | 此前 cacheRead | 此后 cacheRead |
| --- | ---: | ---: | ---: | ---: |
| 轨迹分析 `2e60aac2` | 1069 | 64,109 | 188,160 | 189,440 |
| 插件开发 `b605ee3c` | 4895 | 54,566 | 354,944 | 355,584 |
| cwt `68b181e4` | 644 | 54,566 | 145,152 | 147,072 |
| harness 评测 `3363d7c2` | 900 | 57,323 | 150,528 | 151,936 |

不同会话的停滞位置不同，取决于超限工具结果第一次出现在历史何处。另有 CodeBuddy 会话曾读取 493,184 个缓存 token，已排除全局固定 189,440 上限。

## 修复和真实模型验证

`src/runtime.ts` 为普通模型 worker 计算本次完整原生输入的 JSON UTF-8 字节数，并用向上取整的 KB 数设置 SDK 的结果落盘阈值。任一原始工具结果的 UTF-8 字节数都不超过整份 JSON 输入字节数，因此 SDK 不会再次把 DSH 已管理的历史工具结果替换为临时预览。阈值由当前输入推导，不设置任意大常量，也不修改 SDK 依赖；原生 WebSearch 分支沿用原行为。

本次没有裁剪上下文、移除 reasoning、降低保留量、过滤工具或切换额度路由。修复会恢复 SDK 曾丢弃的结果正文，因此首次请求的输入可能增加；应关注后续重复请求的费用，而非要求首次冷缓存费用下降。

使用 `codebuddy:deepseek-v4.1-flash`、`high`，执行了 3 次真实模型请求。测试保留 266K 级上下文和超过 50KB 的历史工具结果，不执行模型工具；1024 的输出限制只用于此独立验收，并未写入生产配置。

| 请求 | miss token | hit token | 输入缓存命中率 | 工具结果末尾验证码 |
| --- | ---: | ---: | ---: | --- |
| 首次冷请求 | 266,384 | 0 | 0% | 842617，正确 |
| 重复历史 | 144 | 266,240 | 99.946% | 842617，正确 |
| 追加消息 | 165 | 266,240 | 99.938% | 842617，正确 |

原始计量记录在 `artifacts/cache-live-20261113/report.json`。此测试证明修复后的大结果可被完整读取，且 CodeBuddy 能复用超过 200K 的前缀；不能用它保证所有真实任务都达到同一命中率。

已执行：`npm run build`、`npm run typecheck`、`npm run test:ci`（68 项通过）、隔离网络的大工具结果重放回归测试、后续 system 消息传递测试、上述 3 次真实 CodeBuddy 调用及 `git diff --check`。隔离测试使用真实官方 SDK 和本地模型 fixture，真实模型验收使用 CodeBuddy 账号；二者不混称。

## 最近任务费用与收益边界

`scripts/analyze-cache.mjs` 只读扫描了 143 个去重会话导出，并与 cost-meter 账本关联。2026-11-13 10:52 左右的账本快照合计约 ¥467.97；账本仍在被运行中的任务更新。这个数字是插件按配置价格估算的费用，不是 CodeBuddy 官方订阅扣量证明。

分析按路由逐次识别；旧会话的历史 route 切换不解释为当前 CodeBuddy 缓存问题。没有重做交接材料中已经解释完的 `ebc1fc32`。

| 会话 | 账本估算累计费用 | 导出成功调用命中率 | 缓存可恢复量的谷价上界 |
| --- | ---: | ---: | ---: |
| 插件开发 `b605ee3c` | ¥69.36 | 71.5% | 不给出同周期费用承诺：账本 383 次，导出 425 次 |
| cwt `68b181e4` | ¥34.29 | 70.0% | ¥13.68 |
| 轨迹分析 `2e60aac2` | ¥21.46 | 82.4% | 不给出同周期费用承诺：账本 286 次，导出 270 次 |
| 知识库评测 `b12d92a0` | ¥20.67 | 96.3% | ¥8.71 |
| cwt 侧会话 `47506da8` | ¥14.48 | 48.1% | ¥2.11 |
| harness 评测 `3363d7c2` | ¥10.54 | 80.0% | ¥7.80 |

“上界”计算的是首个超限结果出现后，相邻请求中旧输入理论上可重新命中的部分；排除期间的 system、header 和历史替换变更，并扣除原有 cacheRead。它不是修复后的实测节省，不包含新增输入，不能当成返还费用或直接汇总成保证收益。按当前账本 Flash 谷价，miss/hit 分别为 $0.15/$0.003 每百万 token，汇率为 6.6683；峰价情景为两倍。路径变动修复并不能消除首次输入、输出生成、工具注册变更、主动修改历史等成本。

仅针对轨迹分析的既有 270 次请求，扫描得到 7,459,840 token 的可恢复上界，约 ¥7.31（谷价）或 ¥14.62（峰价）。保持原始输入量不变的数学情景中，命中率上界约为 97.4%；恢复被 SDK 隐藏的正文会改变真实输入量，因此必须通过安装后的实际任务观测确认收益。

交接材料中 781,510 个 miss token 约 ¥7.8 的换算有十倍误差：当前配置下其全额 miss 成本约 ¥0.78–1.56，若变成缓存读取，净节省还须减去 hit 费用。此外，原材料的 8.31M / 8.75M 约为 95%，不是 81%。

## 上下文为何增长

请求历史包含系统规则、工具 schema、用户输入、运行上下文、助手 reasoning/回答/调用参数和工具结果。多个高费用样本中，长任务的助手历史与工具输出是主要增长来源，不能把这等同于插件重复收费，也不能据此删除 reasoning。

`dsh-context` 当前快照中，cwt 的估算上下文为 587,099 token，其中助手 411,557（reasoning 375,775）、工具结果 129,051、工具声明 29,845；harness 评测为 232,610，其中助手 106,736、工具结果 79,086、工具声明 28,970。这些是插件估算快照，采样时间不同于现有 JSONL 导出；不与 API usage 强行对齐。SDK 的二次预览也会使 DSH 以为已发送的内容与实际出站内容不一致。

当前证据支持先修复传输改写，保留回答质量，再观察任务费用。没有证据支持强制 190K 截断、提前压缩或按所谓固定上限拆分会话。减少无目的重复查询可以降低新增输入和轮数，但本次没有把它计入节省额度。

## 机制 A：已定位，未完成完整修复

`packages/core/system-prompt/src/index.ts` 的 section 组装与 `system-prompt/assemble` 瀑布形成 system 文本；工具 schema 在瀑布之外组装到最终 assembly。不能在该瀑布里假设 `assembly.tools` 存在。

`packages/core/agent-loop/src/agent.ts` 的 `buildRequest()` 已把工具增删记录到 `developer/message`。但 CodeBuddy 适配器没有声明 `toolUpdate` 能力，DSH LLM 层 `projectToolUpdates()` 会滤掉这些结构化 developer 更新，向该路由发送当前完整工具声明。工具变化还会启动新的请求系列。不能仅凭日志里存在 developer 消息就声称它已发给模型。

本次轨迹分析的实际 system 变化包括：seq 526 卸载 genui 的 UI 使用说明；seq 953/1833 添加或移除 plan 策略；seq 1679 加入用户自定义的系统指令。这几项不是同一个注入点。

plan 策略由 `packages/plan/plan-mode/src/index.ts` 注册的 `plan:policy` section 根据状态返回整段文字或空串；当前路由未声明 `systemPromptUpdate`，`SystemPromptProjection.project()` 会替换前部 system 节点，破坏历史前缀。移除工具本身不必重写 system，但同时卸载插件会移除其 section。

官方 SDK 出站 fixture 能保留后续 system 消息的原有前缀及其 role，但后续真实网关和模型测试未通过完整语义验收。不能据此声明 `systemPromptUpdate`；仅开启该标志也不能解决 plan 首次启用时同时发生的工具变化。

完整修复的验收应为：首次 system 节点及已有请求前缀不改写；plan 策略更新以保留优先级的后续消息传递；工具增删由 SDK/网关实际支持的动态声明协议传递；移除工具仍由 DSH 执行层拒绝；初始 plan 模式、开/关、恢复、压缩后的状态均正确；真实模型和缓存计量通过。当前尚未实现这些变更，不能声称机制 A 已通过验收。

如果严格要求所有 `system/message` 文本都永远相同，就必须重新设计 plan 策略的固定规则与动态状态表达，并验证指令优先级；不能把高优先级限制简单改成普通 user 文本。也不能伪报 `toolUpdate` 能力、保留已经卸载的可执行工具，或重装出过故障的 tool-index 插件。

### 真实协议验证补充（2026-11-13 11:07–11:11）

执行了 10 次有上限的 CodeBuddy 请求，每次输出上限 1024、effort 为 high，不执行工具、不修改已有会话。原始记录在 `artifacts/conversation-updates-probe{,-2,-3}/report.json`；可使用 `scripts/probe-conversation-updates.mjs --run --case <name> --out <新目录>` 单独复现。

| 测试 | 真实结果 | 能证明什么 |
| --- | --- | --- |
| 后续 system 使用现有 `input_text` 格式，进入／退出 plan，共 2 次 | 均为 HTTP 400，拒绝 `input_text` 内容类型 | 出站 role 保留不足以证明真实请求可用 |
| 后续 system 使用标准 `text`，进入 plan | 返回 `PLAN_ONLY` | 此次请求遵守了新增限制 |
| 后续 system 使用标准 `text`，退出 plan | 仍返回 `PLAN_ONLY`，预期为 `IMPLEMENT_ALLOWED` | 不满足“最新 system 完整替换旧 system”的能力声明 |
| 后续 system 使用字符串，退出 plan | 仍返回 `PLAN_ONLY` | 此格式也没有解决本次反例 |
| 后续 developer 使用标准 `text`，退出 plan | 仍返回 `PLAN_ONLY` | 不能用改 role 绕过问题 |
| 修改前部 system 的退出对照 | 返回 `IMPLEMENT_ALLOWED` | 当前前部 system 替换路径能正确传达本次模式状态 |
| 前部 system 预先约定“最新 system 生效” | 返回 `IMPLEMENT_ALLOWED` | 可作为独立设计的候选，但不是原有任意 system 更新语义的通过证据；尚未验证注入区分、其他策略及真实 DSH 状态链 |
| 在后续 system 中发送原生 `tool_addition` 内容 | HTTP 400，拒绝 `tool_addition` | 当前这条 SDK／网关路径不接受此格式 |
| 在后续消息 `providerData.toolsAdded` 中提供新增工具 | 请求完成，但模型返回 `UNAVAILABLE` | 本次工具没有通过该表示方式被模型识别 |

没有根据模型的 reasoning 自述断言网关内部如何转换 role，也没有将两个失败的工具表示方式扩大成“所有可能协议均不支持”的结论。本轮结果已足以否决直接开启两个能力标志的方案。保留原来的完整前部 system 与完整当前工具声明，可以避免为缓存牺牲行为一致性。

另在隔离网络的官方 SDK 探测中，MCP server 设置 `alwaysLoad: false / defer_loading: true` 后，Flash 的真实出站 `tools` 仍为普通完整 function 声明，没有延迟声明标记。不能把这个 SDK 工具发现开关直接当作 DSH 的动态工具协议。

### 不使用 plan 时的剩余影响

不进入 plan 模式可以避开 plan section 的开关及首次引入 `exit_plan_mode` 的工具声明变化。已经处于 plan 的会话需先退出；仅仅不再输入 `/plan` 不会清除已持久化状态，GUI 模式开关也属于同一功能。本轮没有关闭、卸载或修改用户的 plan 配置。

对现有导出逐个比较完整工具 schema，在 54 个包含 CodeBuddy Flash 请求的会话中，43 个没有工具 schema 变化；另外 11 个共有 17 次变化：10 次移除 `render_ui` / `validate_dsh_ui`，6 次涉及 `exit_plan_mode`，1 次涉及其他工具集合更新。UI 工具移除均出现在 2026-11-13 北京时间 00:25–00:43 的同一时间段；这只证明这些会话观察到了相近时间的工具变化，不据此断言卸载根因。逐项记录在 `artifacts/cache-prefix-fix/tool-changes.json`。

不使用 plan 后，仍需区分：SDK 大工具结果随机路径缺陷（已有修复，当前安装文件已包含该修复，业务验收待补）、插件或 MCP 工具清单变化、修改系统指令，以及实际改变旧历史的编辑／压缩／裁剪。后几类操作确实改变了请求，可能产生一次或若干次冷输入；不能把它们与 SDK 缺陷引起的持续停滞混为一谈。`request/header` 的 resume 事件本身也不等于前缀变化，本次轨迹样本的多次 resume 工具清单相同。

在用户接受不使用 plan 的前提下，当前更直接的方案是应用已验证的大工具结果修复，在连续任务中稳定工具与系统配置，并观察真实工作负载；没有证据要求通过重新设计 plan 来处理其余缓存问题。该方案不能保证永远没有缓存 miss，也不承诺复杂任务的回答质量已被本次验证码测试全面覆盖。

## 交付与后续验证

修复在 `src/runtime.ts`；测试在 `scripts/test-sdk.mjs`、`scripts/test-cache-live.mjs`；复查脚本为 `scripts/analyze-cache.mjs`。11:14 现场的 web profile 已引用 `artifacts/cache-prefix-fix/dsh-codebuddy-sdk-0.1.14.tgz`，安装文件含修复。DSH web 进程启动时间为 11:08:37，晚于该文件的安装时间 11:07:57；启动时间先后本身不替代模块加载和真实业务验收。

候选包位于 `artifacts/cache-prefix-fix/dsh-codebuddy-sdk-0.1.14.tgz`，是带本地修复的同版本包，与原有包路径不同。安装前按路径和校验值识别，不能只看版本号。

运行环境变更需单独授权，本轮未执行此类动作。后续应核对实际加载的 runtime 文件，使用原会话继续少量真实任务，对照完整结果、cacheRead 增长和 cost-meter 估算；保留旧包用于授权回退。机制 A 的动态工具协议和系统指令替换未通过真实语义验收，不能用本次 B 修复的 PASS 替代，也不应开启相应能力标志。
