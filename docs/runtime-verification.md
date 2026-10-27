> 本报告记录旧 Session 接口的验收。当前 Server 改造结果见 [Server 验收](server-verification.md)。

# 重构后的运行验证

2026-10-26。范围：本地改造、独立测试 profile 和有限真实调用。未 commit、push、发布、部署或安装到日常 web profile，未改变日常 DSH 默认模型及凭据。

## 实际结果

通过真实 **DSH SDK app 入口 → 本插件 → CodeBuddy 官方 SDK / CLI → 现有 CodeBuddy 账户通道** 连续完成两轮：

1. 用户问 `sum(i*i for i in range(5))`，模型回复 `30`。
2. 用户只要求把“刚才表达式”的 `range(5)` 改成 `range(3)`，模型回复 `5`。

第二轮依赖第一轮上下文；两轮均在 DSH 中提交为 completed。请求模型为 `deepseek-v4.1-flash`，服务端报告 `deepseek-v4.1-flash-ioa`。插件记录两者，接受已观察到的企业部署后缀；其他模型或版本替换仍报错。该标签不能证明与 DeepSeek 官方部署的权重和采样参数完全相同。

以下采用修正后的 DSH 互斥计数口径：

| 轮次 | 未缓存输入 | 缓存读取 | 缓存写入 | 输出 | 总计 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 260 | 5760 | 0 | 39 | 6059 |
| 2 | 208 | 5888 | 0 | 23 | 6119 |

SDK 原始 `input_tokens` 分别为 6020、6096，包含缓存输入；DSH 的 `inputTokens` 是扣除缓存后的值。缓存分离修复后，用受控端点复现并验证了换算规则；表中实际调用数据由修复前保留的原始 SDK 计数重新换算，没有追加付费请求。输出计数包含模型生成的思考与正文，SDK 没提供的细分项未猜测。

机器可读证据见 [runtime-evidence.json](runtime-evidence.json)。本地原始摘要和调用尝试台账在被 Git 忽略的 `artifacts/live/`。

## 调用预算与对照边界

CodeBuddy 共进行 **3 次调用尝试**：第一次发现服务端 `-ioa` 名称而被原严格校验拦住；兼容性修复后，剩下两次用于上面的真实 DSH 连续对话。第一次的 token usage 未返回，不记为零。

原生 DSH 账户通道进行了 **1 次对照尝试**，在现有 DSH 0.2.1-rc.3 的 Messages 解析处失败：`MALFORMED_RESPONSE: DeepSeek Messages stream: event precedes message_start`。它使用现有 DeepSeek 账户授权，属于原生账号通道，不是已配置独立 API key 的对照。未扩大范围去修改 DSH 或其上游服务。原生输出和 usage 未取得，因此**未完成真实双通道效果对照**。

每次测试显式限制 256 输出 token。CodeBuddy 的三次测试机会已用完，没有继续追加模型调用。台账记录客户端尝试，不是人民币扣费记录，也不是对服务端或 SDK 内部网络重试次数的账单审计。

短题验证了接入、回复、上下文和 usage 链路，不能据此认定复杂编程能力等价。

## 本地验证

版本：DSH / dsh-llm 0.2.1-rc.3；SDK 0.3.287；SDK 自带 CLI 2.172.1。Node 26.0.0 用于初期构建；本机日常 DSH 启动器的 Node 24.11.1 也完成了类型检查、单元测试和完整 SDK 集成测试，因此运行要求为 Node >=24。

- 构建、项目类型检查和 SDK 公开输入契约编译检查通过。
- 19 项单元 / 挂载测试通过，覆盖历史校验、恢复摘要、模型元数据、部署名称、真实 MCP 客户端、并发匹配、歧义调用拒绝、流组装、缓存计数和未知计数。
- 10 项 SDK 集成检查通过：SSE 思考/正文/usage、系统提示词覆盖、精确模型与输出 cap、项目设置隔离、官方 resume、历史编辑/导入拒绝、缓存换算、MCP 往返、截断请求控制、实际 DSH headless 与持久 SDK 入口、取消。多个相关断言合并在同一检查项内。
- 持久 DSH SDK 用例先完成两轮，再通过 DSH 的真实 `read` 工具读取临时文件；下一次模型请求中出现文件内容 `DSH_REAL_FILE_SENTINEL`，该工具轮次正常完成。工具实际由 DSH 执行，模型端点采用固定响应。
- 随后关闭整个 DSH 进程，启动新进程，通过公开 `session/resume` 恢复同一个 DSH 会话，继续一轮。模型请求保留第一轮、第二轮和真实文件工具结果，重启后轮次正常完成。

SDK 集成测试整体运行在 `unshare -n` 独立网络命名空间，仅启用 loopback；使用全新 HOME、配置目录和虚拟 key，不加载真实账户凭据，不访问外部模型。完整请求、事件和测试结果保存在 `artifacts/sdk-integration/`。

重跑本地验证：

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm run test:ci
npm run test:integration
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --skipLibCheck \
  --module NodeNext --target ES2022 scripts/goal-0/sdk-contract.ts
```

实际调用需要显式 `--run`，并受 `artifacts/live/budget.json` 限制。默认测试不执行实际模型调用；本次台账已达到 CodeBuddy 通道上限。

## 关键修复依据

原版本只发送最后一条 user 文本，并遗漏正常 DSH loop 放在 `messages` 中的 system。本版本显式覆盖 system，并由官方 SDK 持久化 / resume 延续它自己创建的会话。

SDK 的 assistant 汇总可能只有思考块，但 SSE 已有正文或工具块；其 usage 还可能是零占位。当前按 SSE 完整消息组装，并使用 DSH 自己的 `BlockAssembler` 形成历史检查点，避免并行块关闭顺序改变下一轮历史。

等待 SDK 的最终 agent result 可能触发截断恢复提示词和重复模型调用。当前在完整模型消息结束后调用公开 `interrupt()`，等待该轮保存，再公开 `close()`。本地截断用例验证只有一个模型请求；该用例不能保证所有网络、错误恢复情形的内部请求数量。

JSON Schema 在 MCP 边界原样传递；所用 CLI 会把模型请求的顶层 `additionalProperties` 改成 `true`。嵌套结构、必填项及约束仍通过测试，实际工具验证由 DSH 负责。该 CLI 行为作为已知差异记录，未通过代理改写请求。

## 当前使用边界

适合在 DSH 中新建会话，选择 CodeBuddy 的 DeepSeek 模型，连续对话、执行文本工具，并恢复本版本创建的已完成会话。

已有角色历史导入、编辑/压缩、未完成工具或取消后的恢复、模型/提示词/工具/参数变化、图片、显式 temperature / stop 仍有限制，具体见 [中文使用说明](../README.zh.md)。不支持的历史和参数明确失败，不能当成已无损支持。

## 官方接口依据

[TypeScript SDK](https://www.codebuddy.cn/docs/cli/sdk-typescript) 提供会话、systemPrompt、MCP 和设置隔离选项；[会话管理](https://www.codebuddy.cn/docs/cli/sdk-sessions) 提供官方恢复机制。部分 CLI 环境变量的依据是锁定版本自带的 `cli/dist/web-ui/docs/.../env-vars.md`。项目规则关闭开关存在于公开分发的 CLI 中，但未找到官网单独说明，README 已标明其版本依赖。

本实现复用正常 SDK 登录与模型调用，没有使用非公开模型网关、身份伪装或私有会话改写。SDK 接入本身不代表对所有具体用途或将来条款的许可结论。
