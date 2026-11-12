import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CodeBuddyToolBridge, codeBuddyToolName } from '../src/tool-bridge.ts'
const schema={type:'object',properties:{nested:{type:'object',properties:{number:{type:'integer',minimum:1},mode:{enum:['a','b']}},required:['number'],additionalProperties:false}},required:['nested'],additionalProperties:false}
test('MCP schema 原样传递，SDK handler 取消前不执行业务工具',async t=>{
 const controller=new AbortController(),bridge=new CodeBuddyToolBridge([{name:'read',description:'read',parameters:schema}])
 const server=await bridge.sdkServer(controller.signal),client=new Client({name:'test',version:'1'})
 const [a,b]=InMemoryTransport.createLinkedPair()
 await Promise.all([server.instance.connect(a),client.connect(b)])
 t.after(async()=>{controller.abort();await client.close();await server.instance.close()})
 assert.deepEqual((await client.listTools()).tools[0].inputSchema,schema)
 let settled=false
 const call=client.callTool({name:'read',arguments:{nested:{number:1}}}).then(result=>{settled=true;return result})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false)
 controller.abort();assert.equal((await call).isError,true)
})
test('允许同名同参数调用，拒绝重复 ID 和额外工具',()=>{
 const bridge=new CodeBuddyToolBridge([{name:'read',description:'',parameters:schema}])
 bridge.noteToolCall('a','read',{});bridge.noteToolCall('b','read',{})
 assert.throws(()=>bridge.noteToolCall('a','read',{}),/重复/)
 assert.throws(()=>bridge.harnessName('Bash'),e=>e.code==='CODEBUDDY_UNKNOWN_TOOL')
})

test('模型把 MCP 前缀写成单下划线时仍解析到已声明工具',()=>{
 const bridge=new CodeBuddyToolBridge([{name:'bash',description:'',parameters:schema}])
 assert.equal(bridge.harnessName('bash'),'bash')
 assert.equal(bridge.harnessName('mcp__custom_tools__bash'),'bash')
 assert.equal(bridge.harnessName('mcp__custom_tools_bash'),'bash')
 assert.throws(()=>bridge.harnessName('mcp__custom_tools__missing'),e=>e.code==='CODEBUDDY_UNKNOWN_TOOL')
 assert.throws(()=>bridge.harnessName('mcp__custom_tools_missing'),e=>e.code==='CODEBUDDY_UNKNOWN_TOOL')
})

test('大小写、下划线变体和嵌套 MCP 名按唯一别名解析',()=>{
 const bridge=new CodeBuddyToolBridge([
  {name:'todo_write',description:'',parameters:schema},
  {name:'mcp__openviking__read',description:'',parameters:schema},
  {name:'list_agents',description:'',parameters:schema},
 ])
 assert.equal(bridge.harnessName('mcp__custom_tools__todowrite'),'todo_write')
 assert.equal(bridge.harnessName('TodoWrite'),'todo_write')
 assert.equal(bridge.harnessName('mcp__custom_tools__mcp__openviking__read'),'mcp__openviking__read')
 assert.equal(bridge.harnessName('mcp__custom_flow_tools__list_agents'),'list_agents')
 assert.throws(()=>bridge.harnessName('mcp__custom_tools_placeholder'),e=>e.code==='CODEBUDDY_UNKNOWN_TOOL')
 const ambiguous=new CodeBuddyToolBridge([{name:'read_file',description:'',parameters:schema},{name:'readfile',description:'',parameters:schema}])
 assert.equal(ambiguous.harnessName('read_file'),'read_file')
 assert.equal(ambiguous.harnessName('readfile'),'readfile')
 assert.throws(()=>ambiguous.harnessName('ReadFile'),e=>e.code==='CODEBUDDY_UNKNOWN_TOOL')
})

test('连字符和下划线工具使用不同声明名称，返回调用准确映射', async t => {
 const tools=['mcp__acceptance-browser__screenshot','mcp__acceptance_browser__screenshot'].map(name=>({name,description:name,parameters:{type:'object',properties:{}}}))
 const bridge=new CodeBuddyToolBridge(tools),controller=new AbortController()
 const server=await bridge.sdkServer(controller.signal),client=new Client({name:'test',version:'1'})
 const [a,b]=InMemoryTransport.createLinkedPair()
 await Promise.all([server.instance.connect(a),client.connect(b)])
 t.after(async()=>{controller.abort();await client.close();await server.instance.close()})
 const declared=(await client.listTools()).tools;assert.ok(declared[0].description.includes(tools[0].name))
 const names=declared.map(t=>t.name)
 assert.notEqual(names[0],names[1]);assert.ok(names.every(n=>/^[a-zA-Z0-9_]{1,64}$/.test(n)))
 for(let i=0;i<2;i++)assert.equal(bridge.harnessName('mcp__custom_tools__'+names[i]),tools[i].name)
 assert.throws(()=>bridge.harnessName('mcp__custom_tools__unregistered'),e=>e.code==='CODEBUDDY_UNKNOWN_TOOL')
 assert.throws(()=>new CodeBuddyToolBridge([tools[0],{...tools[1],name:codeBuddyToolName(tools[0].name)}]),/冲突/)
})
