import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestPolicy } from '../src/request-policy.ts'
test('公开 HTTP 策略允许目录请求，阻止第二次模型请求并保留代理环境',()=>{
 const c=new AbortController(),p=requestPolicy(c),env={HTTPS_PROXY:'http://proxy.invalid:8080',NO_PROXY:'localhost'}
 assert.deepEqual(p.resolve('https://api.example/models',env),{proxyUrl:env.HTTPS_PROXY,noProxy:'localhost'})
 p.resolve('https://api.example/v1/chat/completions',env)
 assert.throws(()=>p.resolve('https://api.example/v1/chat/completions',env),error=>error.code==='CODEBUDDY_RETRY_BLOCKED')
 assert.equal(c.signal.aborted,true)
})
