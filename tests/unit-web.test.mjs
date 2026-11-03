import {test} from 'node:test'
import assert from 'node:assert/strict'
import {searchResult,CodeBuddySearchProvider} from '../src/web.ts'
test('原生搜索来源直接映射、去重并拒绝非网页链接',()=>{
 const result=searchResult({type:'web_search_tool_result',results:[{url:'https://example.com',title:'Title',snippet:'Actual snippet'},{url:'https://example.com',title:'duplicate'},{url:'file:///etc/passwd'},{url:'invalid'}]})
 assert.deepEqual(result,{sources:[{url:'https://example.com',title:'Title',snippet:'Actual snippet'}],truncated:false})
})
test('模型答案不能冒充搜索来源，真实空结果允许返回',()=>{
 assert.throws(()=>searchResult({text:'Here is https://example.com'}),/结构化/)
 assert.throws(()=>searchResult({type:'web_search_tool_result',results:[{url:'invalid'}]}),/有效来源/)
 assert.deepEqual(searchResult({type:'web_search_tool_result',results:[]}).sources,[])
})
test('搜索取消和插件卸载不会启动新 worker',async()=>{
 const provider=new CodeBuddySearchProvider({},()=>{})
 await assert.rejects(provider.search({query:'q'},AbortSignal.abort()),{name:'AbortError'})
 await provider.dispose()
 assert.equal(provider.available(),false)
 await assert.rejects(provider.search({query:'q'}),/已关闭/)
})

test('DeepSeek Flash 搜索显式使用 high，并记录实际辅助模型',async()=>{
 const childProcess=await import('node:child_process'),{syncBuiltinESMExports}=await import('node:module'),{EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream')
 const original=childProcess.default.fork;let sent,record
 childProcess.default.fork=()=>{
  const child=new EventEmitter();child.stderr=new PassThrough();child.connected=false;child.unref=()=>{}
  child.send=(packet,callback)=>{sent=packet.request;queueMicrotask(()=>{child.emit('message',{type:'message',message:{type:'web_search_result',searchResult:{type:'web_search_tool_result',results:[{url:'https://example.com',title:'source'}]}}});child.emit('message',{type:'complete'});child.emit('close',0);callback?.()})};return child
 };syncBuiltinESMExports()
 try{const provider=new CodeBuddySearchProvider({searchModel:'deepseek-v4.1-flash'},e=>record=e);const result=await provider.search({query:'q'});assert.equal(sent.model,'deepseek-v4.1-flash');assert.equal(sent.effort,'high');assert.equal(sent.maxTokens,1024);assert.equal(result.sources.length,1);assert.equal(record.model,'deepseek-v4.1-flash');await provider.dispose()}
 finally{childProcess.default.fork=original;syncBuiltinESMExports()}
})
