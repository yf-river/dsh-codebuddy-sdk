import assert from 'node:assert/strict'

// 摘要允许引用原文；节点 ID 才能证明原消息是否仍在发送历史中。
export function assertMessageRemoved(snapshot,id) {
 assert.ok(typeof id==='string'&&id.length,'缺少原消息 ID，不能证明原文已替换')
 assert.ok(!snapshot.messages.some(message=>message.id===id),`原消息节点仍在请求中：${id}`)
}
