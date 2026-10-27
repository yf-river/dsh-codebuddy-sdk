import{mkdtempSync,writeFileSync}from'node:fs'
import{tmpdir}from'node:os'
import{resolve,dirname}from'node:path'
import{spawnSync}from'node:child_process'
export function scoreCode(item,code,out){
 const dir=mkdtempSync(resolve(tmpdir(),'dsh-code-score-'))
 writeFileSync(resolve(dir,item.file),code);writeFileSync(resolve(dir,'task.test.mjs'),item.tests)
 const run=spawnSync(process.execPath,['--test','--test-reporter=tap','task.test.mjs'],{cwd:dir,env:{PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:dir,TMPDIR:dir,TZ:'Asia/Shanghai'},encoding:'utf8',timeout:15000,maxBuffer:512*1024})
 const result={case:item.id,passed:run.status===0,exitCode:run.status,errorType:run.error?.code,tests:Number(run.stdout?.match(/# tests (\d+)/)?.[1]??0),pass:Number(run.stdout?.match(/# pass (\d+)/)?.[1]??0),fail:Number(run.stdout?.match(/# fail (\d+)/)?.[1]??0)}
 if(out){writeFileSync(out+'.json',JSON.stringify(result,null,2));writeFileSync(out+'.tap',(run.stdout??'')+(run.stderr??''))}
 return result
}
export function parseCode(response){let text=response.blocks.filter(b=>b.type==='text').map(b=>b.text).join('').trim();if(text.startsWith('```'))text=text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');const value=JSON.parse(text);if(typeof value.code!=='string')throw new Error('response JSON lacks code');return value.code}
