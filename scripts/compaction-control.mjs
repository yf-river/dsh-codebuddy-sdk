// 仅供临时验收 profile：调用 DSH 公共命令入口，不随插件发布。
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { createServer } from 'node:http'
import {dirname,resolve} from 'node:path'
import { writeFileSync,readFileSync,renameSync,existsSync } from 'node:fs'
export const inject=['compaction','commands','toolResultPruner','tokenMeter','llm']
export async function apply(ctx,config){
 const agents=new Map(),prunePending=new Set()
 if(config.budgetFile)ctx.on('llm/stream',async function*(options,next){
  const ledger=JSON.parse(readFileSync(config.budgetFile,'utf8'))
  if(ledger.stopFile&&existsSync(ledger.stopFile))throw new Error('Experiment canceled before model request')
  const inputBytes=Buffer.byteLength(JSON.stringify({messages:options.messages,tools:options.tools,system:options.system}))
  if(options.provider!==(ledger.provider??'codebuddy')||!options.maxTokens||options.maxTokens>(options.purpose==='compaction'?(ledger.maxSummaryTokens??ledger.maxOutputTokens):ledger.maxOutputTokens)||inputBytes>(ledger.maxInputBytes??65536))throw new Error('Live acceptance request exceeds its provider/output/input budget')
  if(ledger.attempts.length>=ledger.limit)throw new Error('Live acceptance budget exhausted')
  const phase=options.purpose==='compaction'?'summary':ledger.currentPhase
  if(ledger.phases&&(!phase||ledger.phases[phase]===undefined||ledger.attempts.filter(a=>a.phase===phase).length>=ledger.phases[phase]))throw new Error('Live acceptance phase budget exhausted')
  const entry={...(phase?{phase}:{}),time:new Date().toISOString(),model:options.model,purpose:options.purpose??'conversation',inputBytes,maxTokens:options.maxTokens}
  if(config.captureRequests)writeFileSync(resolve(dirname(config.budgetFile),`${ledger.phases?(ledger.provider??'codebuddy')+'-':''}request-${ledger.attempts.length+1}.json`),JSON.stringify({purpose:options.purpose??'conversation',messages:options.messages,tools:options.tools,system:options.system},null,2),{mode:0o600})
  ledger.attempts.push(entry)
  writeFileSync(config.budgetFile+'.tmp',JSON.stringify(ledger,null,2),{mode:0o600});renameSync(config.budgetFile+'.tmp',config.budgetFile)
  let usage,finish,reported
  const started=performance.now()
  try{for await(const chunk of next()){
   if(chunk.type==='usage')usage=chunk.usage
   if(chunk.type==='finish'){finish=chunk.reason.kind;reported=chunk.replayState?.response}
   yield chunk
  }}finally{
   if(ledger.phases){const latest=JSON.parse(readFileSync(config.budgetFile,'utf8'));Object.assign(latest.attempts[ledger.attempts.length-1],{durationMs:Math.round(performance.now()-started),...(usage?{usage}:{}),...(finish?{finish}:{}),...(reported?{reported}:{} )});writeFileSync(config.budgetFile+'.tmp',JSON.stringify(latest,null,2),{mode:0o600});renameSync(config.budgetFile+'.tmp',config.budgetFile)}
  }
 })
 ctx.on('agent/created',({agent})=>{agents.set(String(agent.session.id),agent)})
 ctx.on('agent/pre-step',({agent},next)=>{const id=String(agent.session.id);agents.set(id,agent);if(prunePending.delete(id))ctx.toolResultPruner.pruneSession(agent.session);return next()})
 const server=createServer(async(req,res)=>{
  try{
   let text='';for await(const chunk of req)text+=chunk
   const input=JSON.parse(text)
   if(input.action==='catalog'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(await ctx.llm.resolveModelInfo(input.provider,input.model)));return}
   if(input.action==='generate'){
    const assembled=new BlockAssembler(),chunks=[]
    for await(const chunk of ctx.llm.stream({provider:input.provider,model:input.model,maxTokens:input.maxTokens??4096,reasoningEffort:input.reasoningEffort??'high',tools:[],messages:[{role:'system',source:{kind:'user'},content:[{type:'text',text:input.system}]},{role:'user',source:{kind:'user'},content:[{type:'text',text:input.prompt}]}],signal:AbortSignal.timeout(180000)})){assembled.push(chunk);if(chunk.type==='finish')chunks.push(chunk)}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({blocks:assembled.blocks(),usage:assembled.usage,finish:chunks.at(-1)}));return
   }
   const agent=agents.get(input.sessionId)
   if(!agent)throw new Error('Test session has no live agent')
   const result=input.action==='measure'?{...ctx.tokenMeter.measure(agent.session),modelInfo:await ctx.llm.resolveModelInfo('codebuddy','deepseek-v4.1-flash'),agentMaxTokens:agent.options.maxTokens}:input.action==='prune'?(prunePending.add(input.sessionId),{queued:true})
    :await ctx.commands.execute(agent,'/compact',[],AbortSignal.timeout(60000))
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result))
  }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}))}
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 writeFileSync(config.portFile,String(server.address().port))
 ctx.effect(()=>()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
}
