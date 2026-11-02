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
