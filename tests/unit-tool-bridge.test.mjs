import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CodeBuddyToolBridge } from '../src/tool-bridge.ts'
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
 assert.throws(()=>bridge.harnessName('Bash'),/未声明/)
})
