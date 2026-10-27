import{test}from'node:test'
import assert from'node:assert/strict'
import{assertMessageRemoved}from'../scripts/acceptance-history.mjs'
test('摘要可引用原文标记，以原消息 ID 判断原文是否仍在请求中',()=>{
 assert.doesNotThrow(()=>assertMessageRemoved({messages:[{id:'summary-new',content:[{type:'text',text:'Summary mentions OLD_USER_REMOVABLE_SENTINEL'}]}]},'original-old'))
 assert.throws(()=>assertMessageRemoved({messages:[{id:'original-old',content:[]}]},'original-old'),/原消息节点仍在/)
 assert.throws(()=>assertMessageRemoved({messages:[]},undefined),/缺少原消息 ID/)
})
