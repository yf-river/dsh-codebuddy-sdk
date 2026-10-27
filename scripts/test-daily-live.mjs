// 日常版本真实验收：预算独立记账，先离线演练，再显式 --run。
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,copyFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createProfile,control} from './dsh-fixture.mjs'
import {startDsh} from './dsh-client.mjs'
import {assertMessageRemoved} from './acceptance-history.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const model='deepseek-v4.1-flash',sid='daily-acceptance'
export async function runDailyAcceptance({home,out,reasoningEffort='off',live=false,resume=false}){
 mkdirSync(out,{recursive:true,mode:0o700})
 const budgetFile=resolve(out,'budget.json')
 if(resume){
  const ledger=JSON.parse(readFileSync(budgetFile))
  assert.equal(ledger.attempts.length,4,'仅允许从已完成前四次的检查点显式继续')
  assert.equal(ledger.limit,8);assert.equal(ledger.maxOutputTokens,512);assert.equal(ledger.maxSummaryTokens,2048);assert.equal(ledger.maxInputBytes,65536)
  assert.equal(JSON.parse(readFileSync(resolve(out,'state.json'))).home,home)
  assert.ok(!existsSync(resolve(out,'initial-report.json')),'已使用过恢复入口，拒绝再次自动恢复')
  copyFileSync(resolve(out,'report.json'),resolve(out,'initial-report.json'))
 }else{
  assert.ok(!existsSync(budgetFile),'已有预算台账，不允许自动重置或重跑')
  writeFileSync(budgetFile,JSON.stringify({limit:8,maxOutputTokens:512,maxSummaryTokens:2048,maxInputBytes:65536,authorization:'User approved at most 8 additional calls for daily reliability acceptance; failures count.',channel:live?'CodeBuddy account':'offline mock; zero paid calls',attempts:[]},null,2),{mode:0o600})
 }
 const cwd=resolve(home,'workspace');mkdirSync(cwd,{recursive:true})
 if(!resume)writeFileSync(resolve(cwd,'acceptance.txt'),'文件验收码：842617\n'+ 'Archived file detail: abcdefghij padding for long history.\n'.repeat(100)+'OLD_FILE_REMOVABLE_SENTINEL\n')
 if(!resume)writeFileSync(resolve(cwd,'verification.txt'),'重启后的验证结果：READY\n')
 const basePatch='- id: compaction-basic\n  config:\n    retainTokens: 512\n    headroomTokens: 512\n    maxTokens: 2048\n    compactionRetries: 0\n'
 let {portFile}=createProfile({home,root,name:'daily-test',budgetFile,captureRequests:true,patch:basePatch})
 const checks=[]
 let client
 const start=async()=>{client=startDsh({home,cwd,profile:'daily-test'});await client.request('initialize',{cwd,provider:'codebuddy',model,reasoningEffort,maxTokens:512})}
 const events=()=>client.notifications.filter(x=>x.method==='session.event').map(x=>x.params.event)
 const snapshots=()=>JSON.parse(readFileSync(budgetFile)).attempts.map((_,i)=>JSON.parse(readFileSync(resolve(out,`request-${i+1}.json`))))
 const completed=(value)=>assert.equal(value.find(e=>e.type==='turn/end')?.data.reason?.kind,'completed',JSON.stringify(value.filter(e=>e.type==='turn/end')))
 const visible=value=>JSON.stringify(value.filter(e=>e.type==='assistant/message').flatMap(e=>e.data.message.content.filter(b=>b.type==='text')))
 const calls=value=>value.filter(e=>e.type==='assistant/message').flatMap(e=>e.data.message.content.filter(b=>b.type==='tool-call'))
 const record=(name,data)=>writeFileSync(resolve(out,name+'.json'),JSON.stringify(data,null,2),{mode:0o600})
 try{
  await start()
  if(resume)await client.request('session/resume',{sessionId:sid})
  if(!resume){
  record('state',{home,cwd,profile:'daily-test',sessionId:sid})
  const first=await client.turn(sid,'请只调用一次 read 工具，读取 acceptance.txt 的全部内容（200 行以内，可设置 limit 2000），不要改动文件，不使用其它工具。记住归档口令 963258，后续会核对。读完只回复文件验收码。下面是可归档背景：OLD_USER_REMOVABLE_SENTINEL '+ 'background context. '.repeat(900))
  record('tool-turn',first);completed(first);assert.equal(calls(first).length,1);assert.ok(visible(first).includes('842617'))
  const before=await control(portFile,sid,'measure');record('before-manual-pressure',before)
  assert.ok(before.surfaceTokens>3000,'长历史尚不足，禁止浪费摘要调用')
  const manual=await control(portFile,sid);record('manual-result',manual)
  assert.equal(manual.result.kind,'success',manual.result.text);assert.ok(manual.result.sourceEventSeq!==undefined)
  const afterManual=await control(portFile,sid,'measure');record('after-manual-pressure',afterManual)
  assert.ok(afterManual.surfaceTokens<before.surfaceTokens,'摘要未减少历史')
  const follow=await client.turn(sid,'不要使用工具，只回复此前文件验收码和归档口令。以下近期背景需要保留供下一步使用：RECENT_TAIL_SENTINEL '+ 'recent context. '.repeat(400))
  record('after-manual-turn',follow);completed(follow)
  assert.ok(visible(follow).includes('842617'));assert.ok(visible(follow).includes('963258'))
  }
  const read=name=>JSON.parse(readFileSync(resolve(out,name+'.json')))
  const first=read('tool-turn'),follow=read('after-manual-turn')
  completed(first);assert.equal(calls(first).length,1);assert.ok(visible(first).includes('842617'))
  assert.ok(read('before-manual-pressure').surfaceTokens>3000)
  assert.equal(read('manual-result').result.kind,'success')
  assert.ok(read('after-manual-pressure').surfaceTokens<read('before-manual-pressure').surfaceTokens)
  completed(follow);for(const fact of ['842617','963258'])assert.ok(visible(follow).includes(fact))
  assert.equal(snapshots().length,4,'前半程必须恰好使用四次调用')
  const originalUser=snapshots()[0].messages.find(m=>m.source?.kind==='user'&&JSON.stringify(m.content).includes('OLD_USER_REMOVABLE_SENTINEL'))
  const originalTool=snapshots()[1].messages.find(m=>m.role==='tool')
  const manualRequest=snapshots()[3]
  const recentUser=manualRequest.messages.find(m=>m.source?.kind==='user'&&JSON.stringify(m.content).includes('RECENT_TAIL_SENTINEL'))
  assertMessageRemoved(manualRequest,originalUser?.id);assertMessageRemoved(manualRequest,originalTool?.id)
  const checkpoint=manualRequest.messages.find(m=>m.source?.kind==='compact-checkpoint')
  assert.ok(checkpoint,'继续生成的请求没有 DSH 摘要节点')
  for(const fact of ['842617','963258'])assert.ok(JSON.stringify(checkpoint.content).includes(fact),'手动摘要缺少关键事实 '+fact)
  record('manual-history-proof',{originalUserId:originalUser.id,originalToolId:originalTool.id,checkpointId:checkpoint.id,checkpointSource:checkpoint.source,recentUserId:recentUser.id})
  checks.push({name:live?'official account tool execution':'mock model tool execution through actual DSH',status:'PASS'})
  checks.push({name:'manual summary adopted and history reduced',status:'PASS'})
  checks.push({name:'continuation uses adopted summary and remembers archived facts',status:'PASS'})
  const pressure=await control(portFile,sid,'measure');record('before-auto-pressure',pressure)
  await client.close()
  // 临时验收降低 DSH 预算来触发自动压缩，不更改模型服务端容量或日常 profile。
  const contextWindow=Math.max(4096,Math.ceil((pressure.totalTokens-256)/0.8))
  ;({portFile}=createProfile({home,root,name:'daily-test',budgetFile,captureRequests:true,patch:basePatch.replace('retainTokens: 512','retainTokens: 0')+'    thresholdRatio: 0.8\n- id: codebuddy\n  config:\n    contextWindow: '+contextWindow+'\n'}))
  await start();await client.request('session/resume',{sessionId:sid})
  const offset=events().length
  const auto=await client.turn(sid,'不要使用工具，只回复此前文件验收码和归档口令。这是当前必须保留的尾部背景：ACTIVE_TAIL_SENTINEL '+ 'active tail. '.repeat(350))
  record('automatic-turn',auto);completed(auto)
  const autoSummary=events().slice(offset).find(e=>e.type==='compaction/summary')
  assert.ok(autoSummary,'未发生自动摘要采用')
  for(const fact of ['842617','963258'])assert.ok(JSON.stringify(autoSummary.data.summary).includes(fact),'自动摘要缺少关键事实 '+fact)
  assert.ok(visible(auto).includes('842617'));assert.ok(visible(auto).includes('963258'))
  assertMessageRemoved(snapshots().at(-1),recentUser.id)
  checks.push({name:'automatic compaction adopted and continued in same session',status:'PASS'})
  record('compaction-events',events())
  await client.close()
  createProfile({home,root,name:'daily-test',budgetFile,captureRequests:true,patch:basePatch})
  await start();await client.request('session/resume',{sessionId:sid})
  const restarted=await client.turn(sid,'请只调用一次 read 读取 verification.txt，不读取其它文件，然后只回复此前文件验收码、此前归档口令、这次读取的验证结果。')
  record('restart-tool-turn',restarted);completed(restarted);assert.equal(calls(restarted).length,1)
  for(const expected of ['842617','963258','READY'])assert.ok(visible(restarted).includes(expected),visible(restarted))
  for(const id of [originalUser.id,originalTool.id,recentUser.id])assertMessageRemoved(snapshots().at(-1),id)
  checks.push({name:'restart restores compacted facts and executes a new DSH tool',status:'PASS'})
 }catch(error){checks.push({name:'daily acceptance',status:'FAILED',message:error.message});throw error}
 finally{
  if(client){record('last-process-events',events());await client.close()}
  const budget=JSON.parse(readFileSync(budgetFile))
  record('report',{channel:live?'CodeBuddy official account':'offline fixture',checks,budget})
  console.log(JSON.stringify({checks,attempts:budget.attempts.length,limit:budget.limit}))
 }
 return {home,out,checks}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 assert.ok(process.argv.includes('--run'),'真实调用必须显式 --run')
 const offline=JSON.parse(readFileSync(resolve(root,'artifacts/sdk-integration/report.json')))
 assert.ok(offline.checks.length>=20&&offline.checks.every(c=>c.status==='PASS'),'最终完整离线测试尚未通过')
 const out=resolve(root,'artifacts/daily-live'),resume=process.argv.includes('--resume-after-manual')
 const home=resume?JSON.parse(readFileSync(resolve(out,'state.json'))).home:mkdtempSync(resolve(tmpdir(),'dsh-daily-live-'))
 await runDailyAcceptance({home,out,live:true,resume})
}
