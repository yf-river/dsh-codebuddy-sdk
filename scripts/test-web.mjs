// 浏览器验收使用真实 DSH Web 与官方运行时，模型端为本地固定响应、虚拟凭据。
import{createServer}from'node:http'
import{spawn}from'node:child_process'
import{mkdtempSync,mkdirSync,writeFileSync,symlinkSync}from'node:fs'
import{tmpdir}from'node:os'
import{resolve,dirname}from'node:path'
import{fileURLToPath}from'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,process.env.DSH_WEB_TEST_OUTPUT??'artifacts/daily-web')
mkdirSync(out,{recursive:true,mode:0o700})
const home=mkdtempSync(resolve(tmpdir(),'dsh-daily-web-')),cwd=resolve(home,'workspace'),profile=resolve(home,'profiles/web-test')
mkdirSync(cwd);mkdirSync(resolve(profile,'node_modules'),{recursive:true});symlinkSync(root,resolve(profile,'node_modules/dsh-codebuddy-sdk'),'dir')
writeFileSync(resolve(cwd,'browser-fixture.txt'),'BROWSER_FILE_READY\n')
writeFileSync(resolve(profile,'package.json'),JSON.stringify({private:true,type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-codebuddy-sdk']}}}))
writeFileSync(resolve(profile,'cordis.patch.yml'),'- id: session-title-llm\n  disabled: true\n- id: agent-default-model\n  config:\n    provider: codebuddy\n    model: deepseek-v4.1-flash\n    reasoningEffort: high\n    maxTokens: 512\n- id: codebuddy\n  config:\n    maxTokens: 512\n')
let mode='text';const requests=[]
const server=createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c
 if(req.url==='/control'){mode=JSON.parse(raw).mode;res.end(JSON.stringify({mode}));return}
 const body=JSON.parse(raw||'{}')
 if(!Array.isArray(body.messages)){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[],models:[]}));return}
 requests.push({mode,body});writeFileSync(resolve(out,'requests.json'),JSON.stringify(requests,null,2),{mode:0o600})
 if(mode==='quota'){res.writeHead(402,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'insufficient_quota',message:'Browser fixture: account balance exhausted'}}));return}
 const hasResult=body.messages.at(-1)?.role==='tool'
 const name=body.tools?.find(t=>t.function.name==='read'||t.function.name.endsWith('__read'))?.function.name
 const tool=mode==='tool'&&!hasResult&&name
 res.writeHead(200,{'content-type':'text/event-stream'})
 const send=(delta,finish_reason=null,usage)=>res.write(`data: ${JSON.stringify({id:'browser-fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})}\n\n`)
 send({role:'assistant',content:''})
 if(tool)send({tool_calls:[{index:0,id:'browser_read_'+requests.length,type:'function',function:{name,arguments:'{"file_path":"browser-fixture.txt"}'}}]})
 else if(mode==='refusal')send({refusal:'Browser fixture: request refused'})
 else send({content:hasResult?'BROWSER_FILE_READY':'BROWSER_CHAT_READY'})
 send({},tool?'tool_calls':mode==='refusal'?'content_filter':'stop',{prompt_tokens:100,completion_tokens:8,total_tokens:108})
 res.end('data: [DONE]\n\n')
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const endpoint=`http://127.0.0.1:${server.address().port}`
const child=spawn(process.execPath,['/data/ida/tools/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js','--profile','web-test','--no-open','--host','127.0.0.1','--port','0'],{cwd,env:{...process.env,HOME:home,XDG_CONFIG_HOME:resolve(home,'config'),CODEBUDDY_CONFIG_DIR:resolve(home,'codebuddy'),CODEBUDDY_API_KEY:'browser-fixture-only',CODEBUDDY_AUTH_TOKEN:'',DSH_HOME:home,DSH_AGENTS_HOME:resolve(home,'agents'),DSH_TELEMETRY_DISABLED:'1',CODEBUDDY_BASE_URL:endpoint,DISABLE_AUTOUPDATER:'1',NO_PROXY:'127.0.0.1,localhost'}})
let log='',announced=false
for(const stream of[child.stdout,child.stderr])stream.on('data',data=>{log+=data;writeFileSync(resolve(out,'process.log'),log);const match=log.match(/http:\/\/127\.0\.0\.1:\d+\/?/);if(match&&!announced){announced=true;const state={home,cwd,endpoint,url:match[0],pid:child.pid};writeFileSync(resolve(out,'state.json'),JSON.stringify(state,null,2));console.log(JSON.stringify(state))}})
const stop=()=>{child.kill('SIGTERM');server.closeAllConnections();server.close();setTimeout(()=>process.exit(),1000).unref()}
process.on('SIGTERM',stop);process.on('SIGINT',stop)
child.on('exit',code=>{server.closeAllConnections();server.close();console.log('Web fixture exited',code)})
