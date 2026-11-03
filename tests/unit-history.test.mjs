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
test('缺少图片附件引用时明确报错',()=>{
 assert.throws(()=>requestHistory({messages:[{role:'user',content:[{type:'image'}]}]}),/附件引用/)
})
test('图文混排、历史图片和工具截图保留顺序与调用关联',()=>{
 const image={type:'image',attachment:{attachmentId:'image-1'}}
 const {input}=requestHistory({messages:[{role:'user',content:[{type:'text',text:'before'},image,{type:'text',text:'after'}]},text('assistant','seen'),{role:'assistant',content:[call('screen')]},{role:'tool',source:{callId:'screen'},content:[{type:'text',text:'screenshot'},image]},text('user','compare')]},new Map([['image-1','data:image/png;base64,AA==']]))
 assert.deepEqual(input[0].content.map(x=>x.type),['input_text','input_image','input_text'])
 assert.equal(input[0].content[1].image,'data:image/png;base64,AA==')
 const result=input.find(x=>x.type==='function_call_result')
 assert.equal(result.callId,'screen')
 assert.deepEqual(result.output.map(x=>x.type),['input_text','input_image'])
})
test('推理以原生 assistant 字段回传，工具调用保留相同推理',()=>{
 const {input}=requestHistory({messages:[text('user','u'),{role:'assistant',content:[{type:'reasoning',text:'why'},call('a')]},result('a')]})
 assert.equal(input.find(x=>x.type==='function_call').providerData.reasoning_content,'why')
 assert.equal(input.some(x=>x.role==='user'&&JSON.stringify(x).includes('why')),false)
})

test('历史工具声明与结果使用一致的安全别名',()=>{
 const name='mcp__acceptance-browser__screenshot'
 const {input}=requestHistory({messages:[text('user','u'),{role:'assistant',content:[{type:'tool-call',id:'a',name,arguments:'{}'}]},result('a','screen')]})
 assert.equal(input[1].name,input[2].name)
 assert.match(input[1].name,/^mcp__custom_tools__mcp__acceptance_browser__screenshot_[a-f0-9]{16}$/)
})
