// 真实实验调度：所有生成先记账；阶段按六小时离线实验的时钟安排。
import assert from'node:assert/strict'
import{readFileSync,writeFileSync,mkdirSync,existsSync,unlinkSync}from'node:fs'
import{resolve,dirname}from'node:path'
import{fileURLToPath}from'node:url'
import{randomUUID,createHash}from'node:crypto'
import{mkdtempSync}from'node:fs'
import{tmpdir}from'node:os'
import{createProfile,control}from'./dsh-fixture.mjs'
import{startDsh}from'./dsh-client.mjs'
import{cases,comparisonSystem,comparisonPrompt}from'./benchmark-cases.mjs'
import{scoreCode,parseCode}from'./benchmark-score.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,'artifacts/long-experiment')
const save=(name,data)=>writeFileSync(resolve(out,name+'.json'),JSON.stringify(data,null,2),{mode:0o600})
const soakRoot=resolve(root,process.env.DSH_LONG_SOAK_OUTPUT??'artifacts/sdk-soak')
const read=name=>JSON.parse(readFileSync(resolve(out,name+'.json')))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const canceled=()=>existsSync(resolve(out,'stop-requested'))
const assertExperimentActive=()=>{if(canceled())throw new Error('experiment canceled');const p=resolve(soakRoot,'progress.json');if(existsSync(p)&&JSON.parse(readFileSync(p)).status==='FAILED')throw new Error('offline soak failed; stop further paid phases')}
const model='deepseek-v4.1-flash',sid='long-real-coding'
const basePatch='- id: compaction-basic\n  config:\n    maxTokens: 4096\n    headroomTokens: 512\n    retainTokens: 512\n    compactionRetries: 0\n- id: permission\n  config:\n    defaultPreset: workspace-write\n    presets:\n      workspace-write:\n        sandbox: workspace-write\n        approval: never\n'
const phase=(channel,value)=>{const path=resolve(out,channel+'-budget.json'),ledger=JSON.parse(readFileSync(path));assert.ok(ledger.phases[value]!==undefined);ledger.currentPhase=value;writeFileSync(path,JSON.stringify(ledger,null,2),{mode:0o600})}
async function api(portFile,input){const port=Number(readFileSync(portFile));const response=await fetch(`http://127.0.0.1:${port}/`,{method:'POST',body:JSON.stringify(input),signal:AbortSignal.timeout(200000)});const value=await response.json();if(!response.ok)throw new Error(value.error);return value}
function setup(){
 if(existsSync(resolve(out,'live-state.json')))return read('live-state')
 const state={home:mkdtempSync(resolve(tmpdir(),'dsh-six-hour-real-')),startedAt:new Date().toISOString(),stages:{}}
 state.cwd=resolve(state.home,'workspace');state.cbHome=resolve(state.home,'codebuddy');state.apiHome=resolve(state.home,'official');mkdirSync(state.cwd,{recursive:true})
 for(const channel of ['codebuddy','official']){
  const path=resolve(out,channel+'-budget.json');assert.ok(!existsSync(path),'existing ledger must not be overwritten')
  const ledger={provider:channel==='codebuddy'?'codebuddy':'deepseek-official',limit:channel==='codebuddy'?16:4,maxOutputTokens:4096,maxSummaryTokens:4096,maxInputBytes:65536,phases:channel==='codebuddy'?{'coding-start':4,'coding-middle':4,summary:2,recovery:2,comparison:4}:{comparison:4},currentPhase:channel==='codebuddy'?'coding-start':'comparison',authorization:'User approved CodeBuddy 16 and official API 4 new generation attempts; failures/summaries count.',attempts:[]}
  writeFileSync(path,JSON.stringify(ledger,null,2),{mode:0o600})
 }
 save('live-state',state);return state
}
function profile(state,channel,extra=''){
 const ledger=read(channel+'-budget');if(!ledger.stopFile){ledger.stopFile=resolve(out,'stop-requested');save(channel+'-budget',ledger)}
 const home=channel==='codebuddy'?state.cbHome:state.apiHome
 const result=createProfile({home,root,name:channel+'-long',budgetFile:resolve(out,channel+'-budget.json'),captureRequests:true,patch:basePatch+extra+(channel==='official'?'- id: llm-deepseek\n  config:\n    apiKeyEnv: DEEPSEEK_API_KEY\n    maxTokens: 4096\n    retryPolicy:\n      mode: normal\n      maxRetries: 0\n':'')})
 if(channel==='official'){
  const secret=read('secret-location');const key=readFileSync(secret.keyFile,'utf8').trim()
  writeFileSync(resolve(home,'.credentials.yaml'),'version: 1\nrefs:\n  DEEPSEEK_API_KEY: '+JSON.stringify(key)+'\n',{mode:0o600})
 }
 return result
}
async function start(state,channel,extra=''){
 const {portFile}=profile(state,channel,extra)
 const client=startDsh({home:channel==='codebuddy'?state.cbHome:state.apiHome,cwd:state.cwd,profile:channel+'-long',env:{DISABLE_AUTOUPDATER:'1',...(channel==='official'?{DEEPSEEK_BASE_URL:'https://api.deepseek.com/anthropic'}:{})},requestTimeoutMs:180000})
 try{await client.request('initialize',{cwd:state.cwd,provider:channel==='codebuddy'?'codebuddy':'deepseek-official',model:channel==='codebuddy'?model:'deepseek-flash',reasoningEffort:'high',maxTokens:4096});return{client,portFile}}catch(e){await client.close();throw e}
}
async function withPause(stage,run){
 const lock=resolve(out,'live-active.json');assert.ok(!existsSync(lock),'live phase already active')
 const id=randomUUID();writeFileSync(lock,JSON.stringify({id,pid:process.pid,stage,time:new Date().toISOString()}),{mode:0o600,flag:'wx'})
 try{
  const deadline=Date.now()+180000
  while(Date.now()<deadline){assertExperimentActive();const file=resolve(soakRoot,'paused.json');if(existsSync(file)&&JSON.parse(readFileSync(file)).id===id)return await run();await sleep(500)}
  throw new Error('offline runner did not acknowledge idle; no generation attempted')
 }finally{if(existsSync(lock)&&JSON.parse(readFileSync(lock)).id===id)unlinkSync(lock)}
}
const completed=events=>assert.equal(events.find(e=>e.type==='turn/end')?.data.reason?.kind,'completed',JSON.stringify(events.filter(e=>e.type==='turn/end')))
function prepareCase(state,item){writeFileSync(resolve(state.cwd,item.file),item.skeleton);writeFileSync(resolve(state.cwd,item.id+'.test.mjs'),item.tests);writeFileSync(resolve(state.cwd,item.id+'-SPEC.md'),item.contract)}
function codingPrompt(item,padding=400){return `请先调用一次 read 读取 ${item.file}，然后实现这个文件，运行 ${process.execPath} --test ${item.id}.test.mjs 验证。只修改 ${item.file}；不要改测试或其它文件，不提交 git。以下已给出完整要求和测试，不需要另外读取测试文件。验收后简短说明结果。\n项目验收口令：631947，压缩和重启后仍需记住。\nCONTRACT:\n${item.contract}\nTESTS:\n${item.tests}\n可归档项目背景：`+'project background. '.repeat(padding)}
async function codingStage(state,middle=false){
 const stage=middle?'middle':'start',item=cases[middle?1:0]
 prepareCase(state,item)
 let actor=await start(state,'codebuddy')
 try{
  if(middle)await actor.client.request('session/resume',{sessionId:sid})
  phase('codebuddy',middle?'coding-middle':'coding-start')
  const events=await actor.client.turn(sid,codingPrompt(item,middle?250:500));save(stage+'-coding-events',events)
  const actual=readFileSync(resolve(state.cwd,item.file),'utf8'),score=scoreCode(item,actual,resolve(out,stage+'-coding-score'));save(stage+'-coding-result',{score,turnCompleted:events.find(e=>e.type==='turn/end')?.data.reason?.kind==='completed',testsUnmodified:readFileSync(resolve(state.cwd,item.id+'.test.mjs'),'utf8')===item.tests})
  const issues=[]
  if(events.find(e=>e.type==='turn/end')?.data.reason?.kind!=='completed')issues.push('coding turn did not complete')
  if(!score.passed)issues.push('behavior tests failed')
  if(readFileSync(resolve(state.cwd,item.id+'.test.mjs'),'utf8')!==item.tests)issues.push('fixed tests modified')
  if(!middle){
   const result=await control(actor.portFile,sid);save('real-manual-result',result);assert.equal(result.result.kind,'success');assert.ok(result.result.sourceEventSeq!==undefined)
   phase('codebuddy','recovery')
   const continued=await actor.client.turn(sid,'不要使用工具，只回复项目验收口令。以下近期背景稍后可归档：'+'recent context. '.repeat(400));save('real-after-manual-events',continued);completed(continued);assert.ok(JSON.stringify(continued.filter(e=>e.type==='assistant/message').map(e=>e.data.message.content)).includes('631947'))
   save('real-pressure-after-start',await control(actor.portFile,sid,'measure'))
  }else{
   const pressure=await control(actor.portFile,sid,'measure');save('real-pressure-before-auto',pressure)
   await actor.client.close()
   const contextWindow=Math.max(8192,Math.ceil((pressure.totalTokens-256)/0.8))
   actor=await start(state,'codebuddy',`- id: codebuddy\n  config:\n    contextWindow: ${contextWindow}\n- id: compaction-basic\n  config:\n    maxTokens: 4096\n    headroomTokens: 512\n    retainTokens: 512\n    thresholdRatio: 0.8\n    compactionRetries: 0\n`)
   await actor.client.request('session/resume',{sessionId:sid});phase('codebuddy','recovery')
   const offset=actor.client.notifications.length
   const continued=await actor.client.turn(sid,'不要使用工具，只回复此前项目验收口令。这里是当前尾部背景：'+'active tail. '.repeat(350));save('real-after-restart-auto-events',continued);completed(continued)
   const notifications=actor.client.notifications.slice(offset).filter(x=>x.method==='session.event').map(x=>x.params.event)
   assert.ok(notifications.some(e=>e.type==='compaction/summary'),'automatic summary was not adopted')
   assert.ok(JSON.stringify(continued.filter(e=>e.type==='assistant/message').map(e=>e.data.message.content)).includes('631947'))
  }
  if(issues.length)throw new Error(issues.join('; '))
 }finally{await actor.client.close()}
}
async function comparison(state){
 const actors={}
 try{
  for(const channel of ['codebuddy','official'])actors[channel]=await start(state,channel)
  const catalog={}
  for(const channel of ['codebuddy','official'])catalog[channel]=await api(actors[channel].portFile,{action:'catalog',provider:channel==='codebuddy'?'codebuddy':'deepseek-official',model:channel==='codebuddy'?model:'deepseek-flash'})
  save('comparison-catalog',catalog)
  phase('codebuddy','comparison');phase('official','comparison')
  const results=[]
  for(const item of cases)for(let repeat=1;repeat<=2;repeat++){
   const prompt=comparisonPrompt(item),inputHash=createHash('sha256').update(JSON.stringify({system:comparisonSystem,prompt,maxTokens:4096,reasoningEffort:'high',tools:[]})).digest('hex')
   for(const channel of repeat===1?['codebuddy','official']:['official','codebuddy']){
    assertExperimentActive()
    const name=`pair-${item.id}-${repeat}-${channel}`,started=performance.now();let result
    try{
     const response=await api(actors[channel].portFile,{action:'generate',provider:channel==='codebuddy'?'codebuddy':'deepseek-official',model:channel==='codebuddy'?model:'deepseek-flash',system:comparisonSystem,prompt,maxTokens:4096,reasoningEffort:'high'})
     save(name+'-response',response)
     const code=parseCode(response);writeFileSync(resolve(out,name+'.mjs'),code)
     result={case:item.id,repeat,channel,inputHash,finish:response.finish?.reason,usage:response.usage,score:scoreCode(item,code,resolve(out,name+'-score'))}
    }catch(error){result={case:item.id,repeat,channel,inputHash,status:'FAILED',failureType:error.name,message:error.message}}
    result.durationMs=Math.round(performance.now()-started);results.push(result);save('comparison-results',results)
   }
  }
  return results
 }finally{for(const actor of Object.values(actors))await actor.client.close()}
}
async function main(){
 mkdirSync(out,{recursive:true,mode:0o700});const state=setup()
 if(process.argv.includes('--preflight')){
  const results={}
  for(const channel of ['codebuddy','official']){const actor=await start(state,channel);try{results[channel]=await api(actor.portFile,{action:'catalog',provider:channel==='codebuddy'?'codebuddy':'deepseek-official',model:channel==='codebuddy'?model:'deepseek-flash'})}finally{await actor.client.close()}}
  save('provider-preflight',results);console.log(JSON.stringify({providers:Object.keys(results),generationAttempts:read('codebuddy-budget').attempts.length+read('official-budget').attempts.length}));return
 }
 assert.ok(process.argv.includes('--run'),'real generation requires explicit --run')
 assert.ok(Object.keys(state.stages).length===0,'scheduler already used; no automatic rerun')
 writeFileSync(resolve(out,'scheduler.lock'),JSON.stringify({pid:process.pid,time:new Date().toISOString()}),{flag:'wx',mode:0o600})
 save('live-state',{...state,status:'WAITING_FOR_SOAK'})
 let anchor
 while(!anchor&&!canceled()){
  const path=resolve(soakRoot,'progress.json')
  if(existsSync(path)){const current=JSON.parse(readFileSync(path));if(current.status==='FAILED')throw new Error('offline soak failed before live start');if(current.startedAt)anchor=Date.parse(current.startedAt)}
  if(!anchor)await sleep(1000)
 }
 if(!anchor)throw new Error('experiment canceled')
 for(const[stage,offset]of[['start',0],['middle',3*3600000],['comparison',5*3600000]]){
  while(Date.now()<anchor+offset){assertExperimentActive();await sleep(Math.min(5000,anchor+offset-Date.now()))}
  state.stages[stage]={status:'RUNNING',startedAt:new Date().toISOString()};save('live-state',state)
  try{const outcomes=await withPause(stage,()=>stage==='comparison'?comparison(state):codingStage(state,stage==='middle'));state.stages[stage].status=stage==='comparison'&&outcomes.some(r=>!r.score?.passed||r.finish?.kind!=='stop')?'PARTIAL':'PASS'}catch(error){state.stages[stage].status='FAILED';state.stages[stage].error={type:error.name,message:error.message}}
  state.stages[stage].finishedAt=new Date().toISOString();save('live-state',state)
 }
 state.status=Object.values(state.stages).every(s=>s.status==='PASS')?'PASS':'PARTIAL';state.finishedAt=new Date().toISOString();save('live-state',state)
 // 只删除本次创建的官方凭据文件；不操作原账号登录态。
 const credential=resolve(state.apiHome,'.credentials.yaml');if(existsSync(credential))unlinkSync(credential)
 const secret=read('secret-location');if(existsSync(secret.keyFile))unlinkSync(secret.keyFile)
 console.log(JSON.stringify({status:state.status,codebuddyAttempts:read('codebuddy-budget').attempts.length,officialAttempts:read('official-budget').attempts.length}))
}
try{await main()}catch(error){save('scheduler-error',{type:error.name,code:error.code,message:error.message});process.exitCode=1}
finally{
 if(process.argv.includes('--run')&&existsSync(resolve(out,'live-state.json'))){
  const state=read('live-state'),credential=resolve(state.apiHome,'.credentials.yaml')
  if(existsSync(credential))unlinkSync(credential)
  const secret=read('secret-location');if(existsSync(secret.keyFile))unlinkSync(secret.keyFile)
 }
}
