// 持续运行真实 DSH/SDK；模型与故障均来自隔离命名空间内的本地端点。
import assert from'node:assert/strict'
import{readFileSync,writeFileSync,appendFileSync,mkdirSync,readdirSync,existsSync,unlinkSync}from'node:fs'
import{resolve}from'node:path'
import{spawnSync,spawn}from'node:child_process'
import{createProfile,control}from'./dsh-fixture.mjs'
import{startDsh}from'./dsh-client.mjs'
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
export async function runSoak({root,output,cwd,stream,system,text,requests,setMode,getModelRequests,setActiveAbort}){
 const duration=Number(process.env.CODEBUDDY_SOAK_DURATION_MS),tickMs=Number(process.env.CODEBUDDY_SOAK_TICK_MS??30000)
 const restartMs=Number(process.env.CODEBUDDY_SOAK_RESTART_MS??3600000)
 const minimum=Number(process.env.CODEBUDDY_SOAK_MINIMUM??600),maximum=Number(process.env.CODEBUDDY_SOAK_MAXIMUM??1000)
 assert.ok(duration>=60000&&tickMs>=1000&&maximum>=minimum)
 const actorRoot=resolve(process.env.HOME,'actors');mkdirSync(actorRoot,{recursive:true})
 const state={status:'PREPARING',durationMs:duration,tickMs,minimumGenerations:minimum,maximumGenerations:maximum,realModelRequests:0,network:'loopback-only namespace',completedOperations:0,expectedFaults:0,manualSummaries:0,automaticSummaries:0,restarts:0,webGenerations:0,failures:[],scenarios:{},startedAt:null}
 const tracked=new Map(),actors=[],controller=new AbortController()
 const stop=()=>controller.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop)
 const save=()=>writeFileSync(resolve(output,'progress.json'),JSON.stringify({...state,nativeModelGenerations:getModelRequests(),modelGenerations:getModelRequests()+state.webGenerations,elapsedMs:state.startedAt?Date.now()-Date.parse(state.startedAt):0},null,2))
 const record=(name,result)=>{state.scenarios[name]=(state.scenarios[name]??0)+1;appendFileSync(resolve(output,'events.jsonl'),JSON.stringify({time:new Date().toISOString(),name,...result})+'\n')}
 const completed=events=>assert.equal(events.find(e=>e.type==='turn/end')?.data.reason?.kind,'completed',JSON.stringify(events.filter(e=>e.type==='turn/end')))
 const pstat=pid=>{try{const s=readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ');const status=readFileSync(`/proc/${pid}/status`,'utf8');return{pid:Number(pid),birth:s[19],state:s[0],rssKiB:Number(status.match(/VmRSS:\s+(\d+)/)?.[1]??0),fds:readdirSync(`/proc/${pid}/fd`).length}}catch{return null}}
 const tree=pid=>{const row=pstat(pid);if(!row)return[];if(Number(pid)!==process.pid)tracked.set(`${row.pid}:${row.birth}`,row);let children=[];try{children=readFileSync(`/proc/${pid}/task/${pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean)}catch{};return[row,...children.flatMap(tree)]}
 const sample=()=>{
  const rows=tree(process.pid).filter(r=>r.pid!==process.pid)
  const stale=[...tracked.values()].map(old=>{const now=pstat(old.pid);return now?.birth===old.birth?now:null}).filter(r=>r&&r.state!=='Z'&&!rows.some(n=>n.pid===r.pid))
  const sample={time:new Date().toISOString(),driverRssKiB:Math.round(process.memoryUsage().rss/1024),dshTreeRssKiB:rows.reduce((s,r)=>s+r.rssKiB,0),dshTreeFds:rows.reduce((s,r)=>s+r.fds,0),actors:rows.filter(r=>actors.some(a=>a.client?.pid===r.pid)),liveOwnedProcesses:rows.length,detachedOwnedProcesses:stale}
  appendFileSync(resolve(output,'resources.jsonl'),JSON.stringify(sample)+'\n')
  return sample
 }
 const patch='- id: codebuddy\n  config:\n    contextWindow: 16000\n- id: compaction-basic\n  config:\n    headroomTokens: 512\n    retainTokens: 512\n    thresholdRatio: 0.65\n    maxTokens: 256\n    compactionRetries: 0\n- id: tool-result-pruner\n  config:\n    thresholdChars: 800\n    headChars: 180\n    tailChars: 180\n'
 async function startActor(actor,resume=false){
  createProfile({home:actor.home,root,name:actor.name,patch})
  actor.client=startDsh({home:actor.home,cwd,profile:actor.name,requestTimeoutMs:60000})
  await actor.client.request('initialize',{cwd,provider:'codebuddy',model:'deepseek-v4.1-flash',reasoningEffort:'high',maxTokens:256})
  if(resume)for(const sid of actor.sessions)if(actor.seen.has(sid))await actor.client.request('session/resume',{sessionId:sid})
 }
 async function turn(actor,sid,prompt,mode='auto'){
  setMode(mode);actor.seen.add(sid)
  const events=await actor.client.turn(sid,prompt);completed(events)
  for(const e of events)if(e.type==='compaction/summary')state.automaticSummaries++
  return events
 }
 async function faultMatrix(){
  const modes=['error-context','error-auth','error-quota','error-rate','error-server','network-error','empty','refusal','max-tokens','broken-stream','bad-tool','split','delayed','large']
  for(const mode of modes){
   setMode(mode)
   const before=getModelRequests();let chunks=[],error
   try{chunks=await stream('soak-fault',[system,text('user','Fixed synthetic fault probe')],mode==='bad-tool'?{tools:[{name:'read',description:'fixture',parameters:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']}}]}:{})}catch(e){error=e}
   const expectedFailure=mode.startsWith('error-')||['network-error','empty','broken-stream','bad-tool'].includes(mode)
   if(expectedFailure)assert.ok(error,`${mode} silently succeeded`)
   else if(mode==='refusal')assert.equal(chunks.at(-1)?.reason?.failure?.code,'REFUSAL')
   else assert.ok(!error,`${mode}: ${error?.message}`)
   assert.equal(getModelRequests()-before,1,`${mode} issued more than one model request`)
   if(mode==='bad-tool')assert.ok(!chunks.some(c=>c.type==='block-end'&&c.block.type==='tool-call'))
   state.expectedFaults+=expectedFailure?1:0;record(mode,{status:'PASS',failureCode:error?.code,finish:chunks.at(-1)?.reason?.kind})
  }
 }
 async function webCheckpoint(stage){
  const out=resolve(output,'web-'+stage),env={...process.env,DSH_WEB_TEST_OUTPUT:out,DSH_BROWSER_LOOPBACK_ONLINE:'1'}
  const child=spawn(process.execPath,['scripts/test-web.mjs'],{cwd:root,env,stdio:['ignore','ignore','pipe']})
  const deadline=Date.now()+30000
  try{
   while(!existsSync(resolve(out,'state.json'))&&Date.now()<deadline){if(child.exitCode!==null)throw new Error('Web fixture exited');await sleep(100)}
   assert.ok(existsSync(resolve(out,'state.json')),'Web fixture did not start')
   const browser=spawn(process.execPath,['scripts/test-web-browser.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']})
   let log='';browser.stdout.on('data',data=>{log+=data});browser.stderr.on('data',data=>{log+=data})
   const timer=setTimeout(()=>browser.kill('SIGTERM'),120000)
   const status=await new Promise(resolve=>browser.once('close',resolve));clearTimeout(timer)
   writeFileSync(resolve(out,'browser-run.log'),log)
   assert.equal(status,0,`Web ${stage} failed`)
   const report=JSON.parse(readFileSync(resolve(out,'report.json')));assert.ok(report.checks.every(c=>c.status==='PASS'))
   state.webGenerations+=JSON.parse(readFileSync(resolve(out,'requests.json'))).length
   record('web-'+stage,{status:'PASS',checks:report.checks.length})
  }finally{
   const closed=new Promise(r=>child.exitCode!==null?r():child.once('close',r));child.kill('SIGTERM');await closed
  }
 }
 let resourceTimer,trackingTimer
 try{
  await faultMatrix()
  const lifecycle=spawnSync(process.execPath,['--import','tsx','--test','tests/unit-runtime.test.mjs'],{cwd:root,encoding:'utf8',timeout:30000})
  writeFileSync(resolve(output,'lifecycle-tests.log'),lifecycle.stdout+lifecycle.stderr)
  assert.equal(lifecycle.status,0,'lifecycle fault regression failed')
  for(const name of ['soak-a','soak-b']){
   const actor={name,home:resolve(actorRoot,name),sessions:[name+'-0',name+'-1'],seen:new Set(),client:null};actors.push(actor);await startActor(actor)
  }
  writeFileSync(resolve(cwd,'fixture.txt'),'SOAK_FILE_HEAD\n'+'long tool output padding '.repeat(200)+'\nSOAK_FILE_TAIL')
  state.startedAt=new Date().toISOString();state.status='RUNNING';trackingTimer=setInterval(()=>tree(process.pid),1000);save();sample();await webCheckpoint('start')
  resourceTimer=setInterval(()=>{sample();save()},60000)
  let next=Date.now(),hour=0,index=0,middleWeb=false
  while(Date.now()-Date.parse(state.startedAt)<duration&&!controller.signal.aborted){
   if(existsSync(resolve(root,'artifacts/long-experiment/stop-requested'))){controller.abort();break}
   if(getModelRequests()+state.webGenerations>=maximum)throw new Error('offline generation cap reached before six-hour duration')
   if(!middleWeb&&Date.now()-Date.parse(state.startedAt)>=duration/2){await webCheckpoint('middle');middleWeb=true}
   const liveLock=resolve(root,'artifacts/long-experiment/live-active.json')
   if(existsSync(liveLock)){
    const lock=JSON.parse(readFileSync(liveLock));state.pausedForLive=true;save()
    writeFileSync(resolve(output,'paused.json'),JSON.stringify({id:lock.id,time:new Date().toISOString()}))
    while(existsSync(liveLock)&&!controller.signal.aborted){
     try{process.kill(lock.pid,0)}catch(error){if(error.code==='ESRCH'){unlinkSync(liveLock);break}}
     await sleep(500)
    }
    state.pausedForLive=false;next=Date.now();save()
   }
   const currentHour=Math.floor((Date.now()-Date.parse(state.startedAt))/restartMs)
   if(currentHour>hour){hour=currentHour;await actors[1].client.close();await startActor(actors[1],true);state.restarts++;record('scheduled-restart',{actor:'soak-b',status:'PASS'})}
   const slot=index%12,a=actors[0],b=actors[1]
   try{
    if(slot===0)await turn(a,a.sessions[0],`SOAK_OLD_${index}: preserve value=42. `+'background '.repeat(1400))
    else if(slot===1){setMode('split');const chunks=await stream('soak-codec',[system,text('user','unicode split fixture')]);assert.equal(chunks.at(-1)?.reason?.kind,'stop')}
    else if(slot===2)await turn(a,a.sessions[1],`SOAK_OLD_${index}: preserve value=42. `+'background '.repeat(1400))
    else if(slot===3){setMode('error-rate');await assert.rejects(()=>stream('soak-rate',[system,text('user','rate limit')]),e=>e.code==='RATE_LIMIT');state.expectedFaults++}
    else if(slot===4)await turn(b,b.sessions[0],`SOAK_READ_REQUEST ${index}: use read on fixture.txt`,'soak-tool')
    else if(slot===5){const fault=['error-auth','error-quota','error-server','network-error','empty','broken-stream','bad-tool'][Math.floor(index/12)%7];setMode(fault);await assert.rejects(()=>stream('soak-error',[system,text('user','fault')],fault==='bad-tool'?{tools:[{name:'read',description:'fixture',parameters:{type:'object'}}]}:{}));state.expectedFaults++}
    else if(slot===6)await turn(b,b.sessions[1],`SOAK_OLD_${index}: preserve value=42. `+'background '.repeat(1400))
    else if(slot===7){setMode('active-cancel');const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),12000);setActiveAbort(()=>abort.abort());try{const chunks=await stream('soak-cancel',[system,text('user','cancel')],{signal:abort.signal});assert.equal(chunks.at(-1)?.reason?.kind,'aborted')}finally{clearTimeout(timer);setActiveAbort(undefined)}}
    else if(slot===8)await turn(a,a.sessions[0],`SOAK_RECENT_${index} `+'recent '.repeat(500))
    else if(slot===9){setMode('auto');const result=await control(resolve(a.home,a.name+'.port'),a.sessions[1]);if(result.result?.sourceEventSeq!==undefined)state.manualSummaries++;await control(resolve(b.home,b.name+'.port'),b.sessions[0],'prune')}
    else if(slot===10){setMode(index%24===10?'large':'max-tokens');const chunks=await stream('soak-length',[system,text('user','large/truncation')]);assert.ok(['stop','max-tokens'].includes(chunks.at(-1)?.reason?.kind))}
    else await turn(b,b.sessions[1],`SOAK_RECENT_${index} `+'recent '.repeat(500))
    state.completedOperations++;record('slot-'+slot,{status:'PASS',index})
   }catch(error){state.failures.push({index,slot,code:error.code,message:error.message});record('slot-'+slot,{status:'FAILED',index,code:error.code});throw error}
   index++;save();next+=tickMs
   const wait=Math.min(Math.max(0,next-Date.now()),Math.max(0,duration-(Date.now()-Date.parse(state.startedAt))))
   if(wait)await new Promise(r=>{const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);r()};const timer=setTimeout(finish,wait);controller.signal.addEventListener('abort',finish,{once:true})})
  }
  if(controller.signal.aborted)throw new Error('soak interrupted')
  assert.ok(getModelRequests()>=minimum,'insufficient offline generations')
  if(duration>=600000)assert.ok(state.manualSummaries>0&&state.automaticSummaries>0,'compaction coverage missing')
  if(duration>=3600000)assert.ok(state.restarts>0,'scheduled restart coverage missing')
  await webCheckpoint('end')
  state.status='PASS'
 }catch(error){state.status='FAILED';state.failure={code:error.code,message:error.message};process.exitCode=1}
 finally{
  if(resourceTimer)clearInterval(resourceTimer)
  if(trackingTimer)clearInterval(trackingTimer)
  for(const actor of actors)if(actor.client)await actor.client.close()
  await sleep(300)
  const lingering=[...tracked.values()].map(old=>{const now=pstat(old.pid);return now?.birth===old.birth&&now.state!=='Z'?now:null}).filter(Boolean)
  state.lingeringOwnedProcesses=lingering
  if(lingering.length){state.status='FAILED';process.exitCode=1}
  state.finishedAt=new Date().toISOString();state.nativeModelGenerations=getModelRequests();state.modelGenerations=getModelRequests()+state.webGenerations;save()
  writeFileSync(resolve(output,'report.json'),JSON.stringify(state,null,2))
  console.log(JSON.stringify({soak:state.status,generations:state.modelGenerations,completedOperations:state.completedOperations,elapsedMs:state.startedAt?Date.now()-Date.parse(state.startedAt):0,failure:state.failure}))
  process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop)
 }
 return state
}
