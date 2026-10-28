# 日常版本验收

> 本文记录前轮 8 次真实验收与当时的 30 项单元检查。本轮清理超时改动和六小时实验单独见 [长时可靠性验收](long-reliability.md)，历史结果不代表新实验已经完成。

目标：在 DSH 中使用 CodeBuddy 账号的 DeepSeek 额度，可靠完成文本聊天、工具调用、长历史压缩和恢复。DSH 管理提示词、历史和业务工具；官方 CodeBuddy Server 负责单次生成。

## 当前版本与交付

本地未发布实现；Node 24.11.1、DSH 0.2.1-rc.3、Agent SDK 0.3.287、CodeBuddy Code 2.172.1。源码和锁定依赖在当前仓库，日常 profile 未安装，未 commit、push 或发布。

日常流程验收 **PASS**。机器证据见 [daily-evidence.json](daily-evidence.json)。

| 验证 | 结果 |
| --- | --- |
| 单元检查 | 30/30 PASS |
| 最终完整隔离集成 | 20/20 PASS，同一次完整运行 |
| 实际 Web 浏览器操作、本地模拟模型 | 6/6 PASS |
| 真实账号手动摘要采用、压缩后续聊 | PASS |
| 真实账号自动摘要采用、压缩后续聊 | PASS |
| 真实账号压缩后重启、恢复事实并使用新工具 | PASS |
| 新增真实调用预算 | 8/8，无追加 |

真实调用使用 `deepseek-v4.1-flash`、reasoning `off`；服务报告模型为 `deepseek-v4.1-flash-ioa`。六次普通生成和两次摘要均取得 token 数据，合计输入 69,038、输出 1,778、总计 70,816 token（DSH/provider 返回口径）；人民币扣费未核账。记录中的缓存读写为 0，不能据此判断服务端实际缓存或计费策略。

2026-10-28 复核并修复了缓存字段读取：网关在第二轮真实调用返回 `prompt_tokens_details.cached_tokens=3840`、`prompt_cache_hit_tokens=3840`、`prompt_cache_miss_tokens=229`，同时把 `cache_read_input_tokens` 零填为 0；旧实现用 `??` 短路，导致缓存读取恒 0。修复后同一 fixture 得到 `cacheReadTokens=3840`、`inputTokens=229`、`totalTokens=4071`；headless 真实第二轮得到 `cacheReadTokens=18688`、`inputTokens=145`。上面的历史 0 值保留为修复前证据。

手动压缩将可见历史估算从 7,004 降至 1,154 token，替换约 6,348 token 的旧消息；自动压缩另替换约 2,277 token 的历史片段。两份摘要均保留验收码和归档口令，后续实际请求已移除被压缩消息的 ID，重启后仍能回答并读取新文件。

首次真实运行在第 4 次后因测试脚本误判停止：模型摘要引用了原文测试标记，脚本据此误判原文残留。原始消息节点实际上已被新摘要替换。校验已修正为消息 ID 比较，补充独立回归检查，并保留 `artifacts/daily-live/initial-report.json`。随后沿用原会话和原预算完成剩余 4 次；未重跑前四次，未追加额度。

旧 Server 改造的 5 次真实调用保存在 `artifacts/server-live/`，旧初轮台账保存在 `artifacts/live/`，均未改写。当前源码与验收脚本的哈希保存在机器证据中。

## 行为与异常恢复

- 空回复及正常结束但仅有推理、没有可用回答的响应返回 `EMPTY_RESPONSE`；不会悄悄结束会话。
- 拒绝正文可见，以 `REFUSAL` 错误结束；`content_filter` 不标为成功。
- 一批工具调用全部通过 ID、名称、JSON 参数和最终输出一致性校验后，才交给 DSH。截断、损坏、重复 ID 或错误结束原因不会交付可执行调用。
- 上下文超限、认证、额度、限流及服务端错误通过结构化 IPC 传给 DSH。只保留公开可获得的错误码、消息、状态、等待时间和请求标识，不传递完整请求、headers 或认证对象。
- SDK 可能在公开终态错误事件之前恢复。插件从公开的 assistant input 错误元数据保留首个原始失败并停止 SDK，让 DSH 处理后续恢复。
- 每次插件生成最多一次出站模型请求。部分网络故障在 SDK 内部重试前没有公开原始失败，返回 `CODEBUDDY_RETRY_BLOCKED`；可手动重试，不能把它误报成已知网络根因。
- 用户取消、worker 退出和插件关闭都有终态；工作目录不存在导致启动失败时也会结束等待。进程收尾使用同时覆盖正常退出和启动失败的 `close` 事件；非零退出不冒充成功。清理仅针对本次拥有的子进程。
- 成功或拒绝终态的回复元数据包含请求模型、报告模型、结束原因和耗时。token/cache 仅记录当前请求可获得的计数；未知值不写成零。token 不等于人民币账单。

## 验证层次

1. 单元检查：流终态、错误传递、历史角色、工具关系、缓存计量、出站次数限制。
2. 隔离集成：真实 DSH 和官方运行时，本地固定模型响应，网络命名空间仅开放 loopback，不消耗账号额度。包含上下文超限后真实 DSH 压缩恢复、认证/额度失败后续聊、连续压缩、取消与大响应传输。
3. Web 浏览器：实际 DSH Web 和 Chromium，临时 HOME、虚拟凭据和本地模型。验证模型选择、聊天、文件工具、额度错误、拒绝及恢复。与隔离集成、真实账号验收分别报告。
4. 真实账号：单独台账最多新增 8 次，失败及摘要都计数；普通输出最多 512 token，摘要最多 2048 token，DSH 请求内容最多 64 KiB。先离线演练同一会话，再验证真实手动和自动摘要采用、继续回答及重启后新工具调用。

真实压缩通过必须证明：摘要完整且被 DSH 采用；历史变小；下一次生成使用摘要且原消息节点已移除（按消息 ID 校验；摘要允许引用原文关键词）；关键事实仍可回答。自动压缩通过临时降低 DSH 的本地上下文预算、将 `retainTokens` 设为 0 触发，确保测试长片段进入摘要；日常保留窗口由用户原配置决定，不改变服务端模型容量。测试控制插件不进入发布包。

## 复现入口

```sh
npm run typecheck
npm run test:ci
npm run test:integration
```

完整离线报告在 `artifacts/sdk-integration/report.json`；测试失败的报告与旧台账不得用删除或改写方式变成通过。离线演练使用不同临时目录保留历史。

可选浏览器验收：运行 `node scripts/test-web.mjs`，在另一终端运行 `node scripts/test-web-browser.mjs`。浏览器工具路径可通过 `DSH_PLAYWRIGHT_MODULE` 和 `DSH_CHROME_PATH` 指定。临时 Web 仅监听回环地址，模型使用虚拟凭据。结束后对该测试命令按 Ctrl-C 关闭。

真实账号入口 `node scripts/test-daily-live.mjs --run` 会拒绝已有台账的自动重跑。若前四次已完整完成而校验中断，可显式附加 `--resume-after-manual` 从原会话继续；该入口严格要求旧台账恰好 4 次且上限仍为 8，保留初次报告，不重置预算、不重跑已完成调用。本轮 8 次授权用完后不能通过换目录或重置台账继续调用。

## 日常安装与回退

以下是验收后的操作说明，本轮未执行：

1. 确认启动 DSH 的 Node 也是 >=24（本机可在启动命令前将 `/usr/local/n/versions/node/24.11.1/bin` 放入 PATH）。备份目标 DSH profile 的 `package.json`、锁文件和 `cordis.patch.yml`，记录当前模型选择；使用 Node >=24。
2. 在仓库构建后执行 `dsh plugin --profile web add /data/ida/ai/dsh-codebuddy-sdk`，再启动该 profile。
3. 在界面选择 CodeBuddy 的精确 DeepSeek 模型。关闭插件不会自动切换到官方 DeepSeek，需手动选择已配置的官方路由。
4. 如需回退，在目标 profile 的 CodeBuddy 插件行设置 `disabled: true`，重启该 profile 并选择官方路由；已有 DSH 会话保留。需要恢复依赖版本时使用安装前的备份。

## 能证明与不能证明的内容

通过上述验收可以说明列出的日常流程和异常边界已工作，不能证明所有任务永不出错，也不能证明与官方 DeepSeek 的编程质量一致。CodeBuddy 仍存在消息包装、工具名前缀、Schema 顶层约束和部署默认值等差异。官方公开接口的使用方式已限定，但这不代替 CodeBuddy 对具体账号使用条款的解释。
