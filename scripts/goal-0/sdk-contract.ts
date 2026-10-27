// 仅编译检查，不执行。SDK 升级后若限制解除，未使用的 @ts-expect-error 会提示重新评估 Goal 0。
import { query, unstable_v2_createSession } from '@tencent-ai/agent-sdk'
import type { Options, UserMessage } from '@tencent-ai/agent-sdk'

export function checkContract() {
  const historicalAssistant: UserMessage = {
    type: 'user', session_id: 'fixture', parent_tool_use_id: null,
    message: {
      // @ts-expect-error 公开输入仅允许 user，不能导入已有 assistant 角色。
      role: 'assistant',
      content: [{ type: 'text', text: 'historical assistant response' }],
    },
  }
  // @ts-expect-error query 的 prompt 不是完整角色消息数组。
  query({ prompt: [{ role: 'assistant', content: 'historical response' }] })
  const options: Options = {
    // @ts-expect-error Options 没有完整历史输入字段。
    messages: [{ role: 'assistant', content: 'historical response' }],
  }
  const session = unstable_v2_createSession({ model: 'deepseek-v4.1-flash' })
  session.send(historicalAssistant)
  return options
}
