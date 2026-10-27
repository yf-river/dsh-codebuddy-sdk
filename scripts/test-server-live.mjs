// 用户批准的新一轮验收；旧 artifacts/live/budget.json 不修改。
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createProfile,control} from './dsh-fixture.mjs'
import {startDsh} from './dsh-client.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,'artifacts/server-live')
if(!process.argv.includes('--run'))throw new Error('真实验收仅在显式 --run 时运行')
const offline=JSON.parse(readFileSync(resolve(root,'artifacts/sdk-integration/report.json'),'utf8'))
assert.ok(offline.checks.length>=12&&offline.checks.every(x=>x.status==='PASS'),'完整离线验收尚未通过')
mkdirSync(out,{recursive:true,mode:0o700})
const budgetFile=resolve(out,'budget.json')
if(!existsSync(budgetFile))writeFileSync(budgetFile,JSON.stringify({limit:5,maxOutputTokens:256,maxSummaryTokens:2048,maxInputBytes:65536,attempts:[]},null,2),{mode:0o600})
const ledger=JSON.parse(readFileSync(budgetFile,'utf8'))
assert.equal(ledger.attempts.length,0,'本轮验收已有调用记录，拒绝自动重跑')
const home=mkdtempSync(resolve(tmpdir(),'dsh-server-live-')),cwd=resolve(home,'workspace')
mkdirSync(cwd)
const {portFile}=createProfile({home,root,name:'server-live',budgetFile,patch:'- id: compaction-basic\n  config:\n    maxTokens: 2048\n'})
const sid='server-live-acceptance',checks=[]
let client=startDsh({home,cwd,profile:'server-live',env:{DISABLE_AUTOUPDATER:'1'}})
const initialize=()=>client.request('initialize',{cwd,provider:'codebuddy',model:'deepseek-v4.1-flash',reasoningEffort:'off',maxTokens:256})
const completed=events=>assert.equal(events.find(e=>e.type==='turn/end')?.data.reason?.kind,'completed',JSON.stringify(events.filter(e=>e.type==='turn/end')))
try{
 writeFileSync(resolve(cwd,'acceptance.txt'),'验收码：842617\n'+ 'Long acceptance context: preserve the six-digit code and the file read result; do not change any files.\n'.repeat(120))
 await initialize()
 const first=await client.turn(sid,'请只调用一次 read 工具读取 acceptance.txt 的全部内容，不能只读前几行，不使用其它工具。然后只回复文件中的六位验收码。')
 writeFileSync(resolve(out,'tool-turn-events.json'),JSON.stringify(first,null,2))
 completed(first)
 assert.ok(JSON.stringify(first.filter(e=>e.type==='assistant/message')).includes('842617'))
 const toolCalls=first.filter(e=>e.type==='assistant/message').flatMap(e=>e.data.message.content.filter(b=>b.type==='tool-call'))
 assert.equal(toolCalls.length,1)
 assert.equal(JSON.parse(readFileSync(budgetFile)).attempts.length,2)
 checks.push({name:'actual DSH tool execution with CodeBuddy account',status:'PASS'})
 const compact=await control(portFile,sid)
 writeFileSync(resolve(out,'compact.json'),JSON.stringify(compact,null,2))
 assert.equal(compact.result.kind,'success',compact.result.text)
 assert.ok(compact.result.sourceEventSeq!==undefined,'manual compaction did not produce a summary')
 checks.push({name:'actual DSH manual compaction',status:'PASS'})
 await client.close();client=startDsh({home,cwd,profile:'server-live',env:{DISABLE_AUTOUPDATER:'1'}})
 await initialize();await client.request('session/resume',{sessionId:sid})
 const last=await client.turn(sid,'不要使用工具，只回复刚才文件中的六位验收码。')
 writeFileSync(resolve(out,'restart-turn-events.json'),JSON.stringify(last,null,2))
 completed(last)
 assert.ok(JSON.stringify(last.filter(e=>e.type==='assistant/message')).includes('842617'))
 checks.push({name:'compacted DSH conversation survives process restart',status:'PASS'})
}catch(e){checks.push({status:'FAILED',name:e.name,message:e.message});process.exitCode=1}
finally{
 await client.close()
 const result={channel:'CodeBuddy official Server',entry:'real DSH SDK app with test-only public command control',checks,budget:JSON.parse(readFileSync(budgetFile,'utf8'))}
 writeFileSync(resolve(out,'report.json'),JSON.stringify(result,null,2),{mode:0o600})
 console.log(JSON.stringify({checks,attempts:result.budget.attempts.length}))
}
