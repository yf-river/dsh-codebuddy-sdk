import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestHistory } from '../src/history.ts'
const text=(role,text)=>({role,content:[{type:'text',text}]})
const call=(id,name='read')=>({type:'tool-call',id,name,arguments:'{"path":"a"}'})
const result=(id,text='ok')=>({role:'tool',source:{callId:id},content:[{type:'text',text}]})
test('DSH system 与 one-shot system 的优先级',()=>{
 assert.equal(requestHistory({messages:[text('system','DSH'),text('user','u')]}).system,'DSH')
 assert.equal(requestHistory({system:'explicit',messages:[text('system','DSH'),text('user','u')]}).system,'explicit')
})
test('摘要、保留角色和 developer 消息直接成为原生角色输入',()=>{
 const {input}=requestHistory({messages:[text('user','summary'),text('developer','additional context'),text('assistant','recent'),text('user','next')]})
 assert.deepEqual(input.map(x=>x.role),['user','developer','assistant','user'])
 assert.equal(input[2].content[0].text,'recent')
})
test('同名同参数并行调用以各自 ID 关联乱序结果',()=>{
 const {input}=requestHistory({messages:[text('user','u'),{role:'assistant',content:[call('a'),call('b')]},result('b','two'),result('a','one')]})
 assert.deepEqual(input.filter(x=>x.type==='function_call_result').map(x=>[x.callId,x.output]),[['b','two'],['a','one']])
})
test('完整历史不依赖旧 SDK replay 元数据或会话文件',()=>{
 const a=text('assistant','old answer');a.source={replayState:{response:{kind:'codebuddy-sdk',version:1,sdkSessionId:'missing'}}}
 assert.equal(requestHistory({messages:[text('user','edited'),a,text('user','next')]}).input.length,3)
})
test('缺失、重复和未知工具结果在生成前失败',()=>{
 assert.throws(()=>requestHistory({messages:[{role:'assistant',content:[call('a')]}]}),/缺少完整结果/)
 assert.throws(()=>requestHistory({messages:[result('a')]}),/无法匹配/)
 assert.throws(()=>requestHistory({messages:[{role:'assistant',content:[call('a'),call('a')]}]}),/重复/)
 assert.throws(()=>requestHistory({messages:[{role:'assistant',content:[call('a')]},result('a'),result('a')]}),/重复/)
})
test('图片和未支持的内容明确报错',()=>{
 assert.throws(()=>requestHistory({messages:[{role:'user',content:[{type:'image'}]}]}),/不支持/)
})
test('推理以原生 assistant 字段回传，工具调用保留相同推理',()=>{
 const {input}=requestHistory({messages:[text('user','u'),{role:'assistant',content:[{type:'reasoning',text:'why'},call('a')]},result('a')]})
 assert.equal(input.find(x=>x.type==='function_call').providerData.reasoning_content,'why')
 assert.equal(input.some(x=>x.role==='user'&&JSON.stringify(x).includes('why')),false)
})
