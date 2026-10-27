import{test}from'node:test'
import assert from'node:assert/strict'
import childProcess from'node:child_process'
import{syncBuiltinESMExports}from'node:module'
import{mkdtempSync,readFileSync}from'node:fs'
import{tmpdir}from'node:os'
import{resolve}from'node:path'
import{EventEmitter}from'node:events'
import{PassThrough}from'node:stream'
import{runWorker}from'../src/runtime.ts'
const realFork=childProcess.fork
async function fixture(scenario,run){
 const cwd=mkdtempSync(resolve(tmpdir(),'dsh-worker-lifecycle-'))
 childProcess.fork=(_file,_args,options)=>realFork(resolve('tests/fixtures/worker-lifecycle.mjs'),[scenario],options)
 syncBuiltinESMExports()
 const controller=new AbortController(),worker=runWorker({model:'deepseek-v4.1-flash',cwd,system:'fixture',input:[],tools:[]},controller.signal)
 try{await run({worker,controller,cwd})}finally{worker.stop();await worker.done;childProcess.fork=realFork;syncBuiltinESMExports()}
}
test('正常收尾不等待五秒，清理异常不丢弃已完成回答',async()=>{
 for(const scenario of ['normal','cleanup-error'])await fixture(scenario,async({worker})=>{const start=performance.now();const cleanup=await worker.verify();assert.equal(cleanup.kind,'normal');assert.ok(performance.now()-start<3000);if(scenario==='cleanup-error')assert.equal(cleanup.reason,'cleanup-error')})
})
test('完成后挂住自动清理整个拥有的进程组，保留成功结果',async()=>{
 await fixture('descendant',async({worker,cwd})=>{
  const start=performance.now(),cleanup=await worker.verify();assert.equal(cleanup.kind,'forced');assert.equal(cleanup.reason,'cleanup-timeout');assert.ok(performance.now()-start<8000)
  const pids=JSON.parse(readFileSync(resolve(cwd,'pids.json')))
  assert.throws(()=>process.kill(pids.pid,0),{code:'ESRCH'})
  // 后代可能短暂处于已死亡待回收状态，不能继续运行。
  try{const stat=readFileSync(`/proc/${pids.descendant}/stat`,'utf8');assert.equal(stat.split(') ')[1][0],'Z')}catch(error){if(error.code!=='ENOENT')throw error}
 })
})
test('主进程已退出而后代仍占用管道时也能结束清理',async()=>{
 await fixture('orphan-pipe',async({worker,cwd})=>{
  const cleanup=await worker.verify();assert.equal(cleanup.kind,'forced')
  const pids=JSON.parse(readFileSync(resolve(cwd,'pids.json')))
  try{const stat=readFileSync(`/proc/${pids.descendant}/stat`,'utf8');assert.equal(stat.split(') ')[1][0],'Z')}catch(error){if(error.code!=='ENOENT')throw error}
 })
})
test('仅有完整输出而缺少 SDK 完成通知时明确失败',async()=>{
 await fixture('no-complete',async({worker})=>{await assert.rejects(worker.verify(),error=>error.code==='CODEBUDDY_FINALIZATION_TIMEOUT')})
})
test('非正常退出不能冒充成功',async()=>{
 await fixture('bad-exit',async({worker})=>{await assert.rejects(worker.verify(),/提前退出/)})
})
test('取消与完成竞态以取消结束，不触发新的生成',async()=>{
 await fixture('hang',async({worker,controller})=>{controller.abort();await assert.rejects(worker.verify(),error=>error.name==='AbortError')})
})
test('无法确认退出时最多六秒结算为清理失败，并释放等待者',async t=>{
 let now=0
 t.mock.method(performance,'now',()=>now)
 t.mock.timers.enable({apis:['setTimeout']})
 const fake=new EventEmitter();fake.connected=true;fake.stderr=new PassThrough();fake.send=(_packet,cb)=>cb?.();fake.unref=()=>{};fake.disconnect=()=>{fake.connected=false}
 childProcess.fork=()=>fake;syncBuiltinESMExports()
 try{
  const worker=runWorker({model:'fixture',cwd:process.cwd(),system:'fixture',input:[],tools:[]})
  fake.emit('message',{type:'complete'})
  const result=assert.rejects(worker.verify(),error=>error.code==='CODEBUDDY_CLEANUP_TIMEOUT')
  now=5000;t.mock.timers.tick(5000);now=6000;t.mock.timers.tick(1000);await result;fake.emit('close',0)
 }finally{childProcess.fork=realFork;syncBuiltinESMExports();t.mock.timers.reset()}
})
