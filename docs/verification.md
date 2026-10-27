# Goal 0：原版本 14ac92e 的基线验证报告

本文件记录重构前的可行性门槛及原版本问题。用户随后确认按“使用 CodeBuddy 额度、尽量接近原生表现”继续实施；当前改动与实际调用结果见 [运行验证](runtime-verification.md)，当前范围见 [实施计划](goal-plan.md)。

日期：2026-10-26。结论：**BLOCKED，停止依赖完整历史导入的生产代码重构。**

现有插件不能等价替代 DSH 原生 DeepSeek。可以用公开 `systemPrompt` 选项覆盖 CodeBuddy 的默认系统提示词，但在本次检查的官方 SDK 接口和文档中，没有找到导入、替换任意外部完整角色历史的受支持方法。只靠修正系统提示词，不能满足本项目约定的已有会话、provider 切换、编辑、压缩和恢复要求。

此次完成可行性验证、可复现脚本、证据断言及文档更正。`src/` 未修改。没有把降低要求的实现作为重构完成，也没有修改私有会话文件。

## 版本与测试边界

| 项 | 现场版本 / 行为 |
| --- | --- |
| 插件基线 | `14ac92ebc73c2a2576ce5c6f0e8f9453acbf66b9`，0.1.5 |
| Node | 独立下载并校验的 v26.0.0，未替换系统 Node |
| SDK | `package-lock.json` 固定的 `@tencent-ai/agent-sdk` 0.3.287 |
| 测试 CLI | SDK 自带的 2.172.1，未使用会自动升级的用户 launcher |
| DSH / 原生适配器 | 0.2.1-rc.3；直接调用实际安装的 `DeepSeekAdapter.stream()` |
| 账户 / 配置 | 新临时 HOME、XDG 和 CodeBuddy 配置目录、环境变量白名单、虚拟 key、空项目目录 |
| 网络 | `unshare -n` 新命名空间，仅启用 loopback；子进程继承，无法访问外部模型服务 |
| 模型响应 | 本地 HTTP 固定 SSE，分别实现 Anthropic Messages 和 OpenAI chat/completions 格式 |
| 真实模型请求 | **0 次**，未消耗 CodeBuddy 账户额度；三个最终用例各有 1 次本地模拟生成请求 |

这是实际 SDK / CLI 到模拟模型端点的请求验证，及原生 DSH adapter 基线验证；不是完整 DSH Loader、Web UI 或真实 DeepSeek 的业务验收。模拟 `usage` 只能证明字段传递，不能证明真实 token 计量、积分、模型服务版本或质量。中途调试也只在隔离网络的模拟端点进行。

准备阶段对用户 CodeBuddy launcher 执行版本查询时，launcher 自动更新到了 2.176.0。这是本次准备工作发生的环境副作用。之后探针全部改用锁定 SDK 自带的 CLI 2.172.1，并在新配置目录中禁用自动更新。日常 DSH 配置未修改，未执行插件安装或部署。

## 复现结果

同一个 DSH 输入包含：system 指令、旧 user 消息、旧 assistant 回复及最终 user 问题，显式 `maxTokens: 256`，无工具。每段包含不同 sentinel，便于判断是否丢失。

| 检查 | 原生 DSH | 当前插件 | SDK 最简公开配置 |
| --- | --- | --- | --- |
| DSH system | 存在 | **缺失**，模型收到 CodeBuddy 默认 system | 显式 `systemPrompt` 可以精确覆盖 |
| 历史 user / assistant | 均存在，保持角色和顺序 | **均缺失** | 公开输入不能接收 assistant 角色历史；本用例只提交最后的 user |
| 最后 user 问题 | 原文文本块 | 添加 `<user_query>` 包装 | 同样添加包装 |
| `max_tokens` | 256 | **128000**，未转发 DSH 上限 | 默认 128000；本用例未设置 SDK 上限 |
| 固定响应 / usage | 收到 `fixture-ok`，11 input / 3 output | 同左 | 同左 |

`<user_query>` 的存在是本版本实测结果，本次没有证明它在所有公开配置下都无法关闭。严格阻塞项是完整历史导入/替换缺口，而不是这个标签本身。

机器可读摘要见 [goal-0-evidence.json](goal-0-evidence.json)。原始输入、请求、SDK 消息和结果保存在被 Git 忽略的 `artifacts/goal-0/`。摘要含请求文件 SHA256，便于对应本地运行证据；重新运行会覆盖这些生成文件。

## 原因与公开能力边界

DSH 的 `GenerateOptions.messages` 是 provider 实际应收到的有序历史，正常 agent loop 把 system 放在首条消息；`GenerateOptions.system` 供手工 one-shot 调用，loop 中为空。对应权威定义在 `@deepseek-ai/dsh-llm/lib/types/types.d.ts` 的 `GenerateOptions`。

插件 [src/index.ts](../src/index.ts) 的 `startConversation()` 则只使用 `lastUserText(options.messages)` 和 `systemPrompt: options.system`。因此旧历史和 loop 内 system 被省略。这两项已有模型请求层面的复现，不只是源码推断。同一方法没有传递 `options.maxTokens`，实测请求上限与 DSH 输入不同。

官方 SDK 0.3.287 的公开契约：

- `query()` 的 `prompt` 是字符串或 `AsyncIterable<UserMessage>`。
- `UserMessage.message.role` 只有 `'user'`。
- v2 `Session.send()` 同样只接受字符串或 `UserMessage`。
- `resume` / `resumeSessionAt` / `forkSession` 关联已有 CodeBuddy 会话，不能据此认定支持导入或替换 DSH 已有的任意角色历史。
- 返回类型中的 `AssistantMessage` 是输出能力；不能把它当成被支持的历史输入。`Options` 也没有 `messages` 字段。

[sdk-contract.ts](../scripts/goal-0/sdk-contract.ts) 用 TypeScript 的预期编译错误验证这些输入限制。它只编译、不运行，不能通过类型绕过来声称官方支持；它也不是对任何未来 SDK、未公开功能或所有可能配置的绝对否定证明。

对已有会话，DSH 的历史可能已经包含另一个 provider 生成的 assistant、工具往返和推理数据。恢复 CodeBuddy 自己维护的旧会话只会延续另一份状态，不能保证与每次 DSH 提供的历史一致。把这些内容串成一个 user prompt 会改变角色语义，私写 transcript 又违反本计划的公开 API 边界。因此本次按约定停止。

工具 schema、工具 ID、推理回放、图片、取消、并发、持久化与真实计费的完整矩阵未开展；后续 Goal 未完成。没有真实模型输出一致性的结论。

## 重跑

需要 Linux、可创建网络命名空间的权限、`iproute2` 和 Node >=26。探针会先验证独立网络命名空间和仅 loopback 地址，隔离建立失败即退出，不会降级到宿主网络。依赖安装需要正常 npm 网络，与探针运行分开。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run typecheck
npm run test:ci

# 指向实际安装的、匹配 DSH 版本的原生 adapter。
DSH_DEEPSEEK_ADAPTER=/data/ida/tools/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js \
  node scripts/goal-0/probe.mjs
node --test scripts/goal-0/verify.test.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --skipLibCheck \
  --module NodeNext --target ES2022 scripts/goal-0/sdk-contract.ts
```

本机使用 `/tmp/dsh-codebuddy-sdk-toolchain/node-v26.0.0-linux-x64/bin/node`，可临时把其 `bin` 加到当前命令的 PATH。没有修改持久 shell 配置。

执行结果：原有 19 项测试通过；新增 5 项证据断言通过；构建、项目类型检查、SDK 契约编译检查通过。**PASS 表示探针成功复现了差异，不表示等价目标通过。**

## 官方资料与解锁条件

已核对的官方资料：

- [TypeScript SDK 参考](https://www.codebuddy.cn/docs/cli/sdk-typescript)：query、UserMessage、v2 Session 和覆盖选项。
- [SDK 会话管理](https://www.codebuddy.cn/docs/cli/sdk-sessions)：恢复会话、多轮发送，未列出外部完整历史替换接口。
- [环境变量参考](https://www.codebuddy.cn/docs/cli/env-vars)：`CODEBUDDY_BASE_URL`、`CODEBUDDY_API_KEY` 用于本地受控端点。
- [HTTP API](https://www.codebuddy.cn/docs/cli/http-api)：补查了相邻公开入口，未找到可替代完整角色历史导入的文档能力；没有将 HTTP API 用于插件改造。
- [安装版本公开类型](https://unpkg.com/@tencent-ai/agent-sdk@0.3.287/lib/types.d.ts)及 [query 定义](https://unpkg.com/@tencent-ai/agent-sdk@0.3.287/lib/query.d.ts)。

严格重构的下一步需要腾讯公开支持外部完整角色历史导入、替换和所需元数据，并用同样的本地端点证明这些内容到达模型。满足后继续 [Goal 1–5](goal-plan.md)。单独补 systemPrompt、缓存 SDK 会话或获得相似的模型回复，均不能满足当前停止条件。
