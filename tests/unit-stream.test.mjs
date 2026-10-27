import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translateStep } from '../src/stream.ts'
import { CodeBuddyToolBridge } from '../src/tool-bridge.ts'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
const model='deepseek-v4.1-flash'
const raw=(delta={},finish_reason=null,usage)=>({type:'model',event:{model,choices:[{delta,finish_reason}],...(usage?{usage}:{})}})
const done=(output=[],usage)=>({type:'response_done',response:{output,usage}})
const text=t=>({type:'message',content:[{type:'output_text',text:t}]})
const tool=(id='a')=>({type:'function_call',callId:id,name:'read',arguments:'{"path":"a"}'})
async function collect(events){const source=(async function*(){yield*events})();const chunks=[];for await(const chunk of translateStep(source,new CodeBuddyToolBridge([{name:'read',description:'',parameters:{type:'object'}}]),model))chunks.push(chunk);const assembled=new BlockAssembler();chunks.forEach(x=>assembled.push(x));return {chunks,assembled}}
test('推理和正文只消费一次，保留模型流中的顺序',async()=>{
 const {assembled}=await collect([raw({reasoning_content:'why'}),raw({content:'answer'}),{type:'output_text_delta',delta:'answer'},raw({},'stop',{prompt_tokens:40,completion_tokens:7}),done([text('answer')])])
 assert.deepEqual(assembled.blocks(),[{type:'reasoning',text:'why'},{type:'text',text:'answer'}])
 assert.equal(assembled.usage.inputTokens,40)
})
test('缓存输入采用互斥口径，缺失计数不伪装成零',async()=>{
 const {assembled}=await collect([raw({content:'ok'},'stop',{prompt_tokens:40,completion_tokens:7,prompt_tokens_details:{cached_tokens:10}}),done([text('ok')])])
 assert.deepEqual(assembled.usage,{inputTokens:30,outputTokens:7,cacheReadTokens:10,totalTokens:47})
 const unknown=await collect([raw({content:'ok'}),done([text('ok')],{inputTokens:0,outputTokens:0})])
 assert.equal(unknown.chunks.some(x=>x.type==='usage'),false)
})
test('长度截断保留真实结束原因',async()=>{
 const {chunks}=await collect([raw({content:'partial'},'length'),done([text('partial')])]);assert.equal(chunks.at(-1).reason.kind,'max-tokens')
})
test('同名同参数工具保持各自调用 ID',async()=>{
 const calls=['a','b'].map((id,index)=>({index,id,function:{name:'read',arguments:'{"path":"a"}'}}))
 const {assembled,chunks}=await collect([raw({tool_calls:calls},'tool_calls'),done([tool('a'),tool('b')])])
 assert.deepEqual(assembled.blocks().map(x=>x.id),['a','b']);assert.equal(chunks.at(-1).reason.kind,'tool-calls')
})
test('错误模型、工具 ID 不一致和不完整流明确失败',async()=>{
 await assert.rejects(()=>collect([{type:'model',event:{model:'other',choices:[]}}]),/返回模型/)
 await assert.rejects(()=>collect([raw({tool_calls:[{index:0,id:'a',function:{name:'read',arguments:'{}'}}]}),done([tool('b')])]),/ID.*不一致/)
 await assert.rejects(()=>collect([raw({content:'partial'})]),/完整输出之前/)
})
test('空回复和仅推理的正常结束不能冒充回答',async()=>{
 for(const events of [[raw({},'stop'),done([])],[raw({reasoning_content:'thinking'},'stop'),done([])]])
  await assert.rejects(()=>collect(events),e=>e.code==='EMPTY_RESPONSE')
})
test('拒绝正文可见并保留失败原因，content_filter 不标为成功',async()=>{
 const {assembled,chunks}=await collect([raw({refusal:'无法处理此请求'},'content_filter'),done([{type:'message',content:[{type:'refusal',refusal:'无法处理此请求'}]}])])
 assert.deepEqual(assembled.blocks(),[{type:'text',text:'无法处理此请求'}])
 assert.equal(chunks.at(-1).reason.kind,'error');assert.equal(chunks.at(-1).reason.failure.code,'REFUSAL')
 const filtered=await collect([raw({},'content_filter'),done([])])
 assert.equal(filtered.chunks.at(-1).reason.failure.code,'REFUSAL')
})
test('截断及损坏工具调用不会发出可执行 block-end',async()=>{
 for(const [args,finish] of [['{}','length'],['{','tool_calls'],['null','tool_calls']]){
  const chunks=[]
  const events=[raw({tool_calls:[{index:0,id:'a',function:{name:'read',arguments:args}}]},finish),done([{...tool(),arguments:args}])]
  await assert.rejects(async()=>{for await(const x of translateStep((async function*(){yield*events})(),new CodeBuddyToolBridge([{name:'read',description:'',parameters:{type:'object'}}]),model))chunks.push(x)})
  assert.ok(!chunks.some(x=>x.type==='block-end'&&x.block.type==='tool-call'))
 }
})
test('整批工具全部校验后才交付，后一个重复 ID 不会提前执行第一个',async()=>{
 const chunks=[]
 await assert.rejects(async()=>{for await(const x of translateStep((async function*(){yield raw({tool_calls:[0,1].map(index=>({index,id:'a',function:{name:'read',arguments:'{}'}}))},'tool_calls');yield done([0,1].map(()=>({...tool(),arguments:'{}'})))})(),new CodeBuddyToolBridge([{name:'read',description:'',parameters:{type:'object'}}]),model))chunks.push(x)},/重复/)
 assert.ok(!chunks.some(x=>x.type==='block-end'&&x.block.type==='tool-call'))
})
test('完整输出不得改写流式工具参数或遗漏工具',async()=>{
 const call={index:0,id:'a',function:{name:'read',arguments:'{}'}}
 await assert.rejects(()=>collect([raw({tool_calls:[call]},'tool_calls'),done([tool()])]),/参数.*不一致/)
 await assert.rejects(()=>collect([raw({tool_calls:[call]},'tool_calls'),done([])]),/数量.*不一致/)
})
test('错误结束原因即使带有合法工具也不会交付执行',async()=>{
 const chunks=[]
 await assert.rejects(async()=>{for await(const x of translateStep((async function*(){yield raw({tool_calls:[{index:0,id:'a',function:{name:'read',arguments:'{}'}}]},'error');yield done([{...tool(),arguments:'{}'}])})(),new CodeBuddyToolBridge([{name:'read',description:'',parameters:{type:'object'}}]),model))chunks.push(x)},e=>e.code==='INVALID_RESPONSE')
 assert.ok(!chunks.some(x=>x.type==='block-end'&&x.block.type==='tool-call'))
})
