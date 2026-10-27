import {test} from 'node:test'
import assert from 'node:assert/strict'
import {failureOf,llmError} from '../src/errors.ts'
import {LlmError} from '@deepseek-ai/dsh-llm'
test('错误经过 JSON IPC 后保留 DSH 恢复所需的字段',()=>{
 const original={code:'rate_limit_error',message:'slow down',status:429,providerRetryAfterMs:2500,requestId:'req-test',headers:{authorization:'SECRET'},request:{token:'SECRET'}}
 const failure=failureOf(original),received=llmError(JSON.parse(JSON.stringify(failure)))
 assert.equal(received.code,'RATE_LIMIT');assert.equal(received.failure.status,429);assert.equal(received.failure.providerRetryAfterMs,2500);assert.equal(received.failure.requestId,'req-test')
 assert.ok(!JSON.stringify(failure).includes('SECRET'))
})
test('只根据明确事实识别上下文、额度、认证和网络错误',()=>{
 for(const [error,code] of [
  [{error:{code:'context_length_exceeded',message:'too long'}},'CONTEXT_WINDOW_EXCEEDED'],
  ['{"error":{"code":"insufficient_quota","message":"balance exhausted"}}','QUOTA'],
  [{status:401,message:'expired'},'AUTH'],[{status:429,message:'limit'},'RATE_LIMIT'],
  [{status:503,message:'unavailable'},'SERVER'],[{code:'ECONNRESET',message:'socket closed'},'NETWORK'],
  [{message:'limit'},'CODEBUDDY_ERROR'],[{code:'CUSTOM',message:'specific'},'CUSTOM'],
 ])assert.equal(failureOf(error).code,code)
 const wrapped=new Error('model request failed',{cause:{code:'context_length_exceeded',message:'over context'}})
 assert.equal(llmError(wrapped).code,'CONTEXT_WINDOW_EXCEEDED')
})
test('忽略无效元数据并保留已有 LlmError',()=>{
 const error=new LlmError('empty','EMPTY_RESPONSE')
 assert.equal(llmError(error),error)
 assert.deepEqual(failureOf({message:'x',status:999,providerRetryAfterMs:-1,requestId:1}),{message:'x',code:'CODEBUDDY_ERROR'})
 const circular={message:'x'};circular.cause=circular;assert.equal(failureOf(circular).message,'x')
})
