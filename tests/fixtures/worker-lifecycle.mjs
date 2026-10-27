// 真实 IPC 与独立进程组，模拟收尾状态；不加载 SDK 或访问模型。
import{writeFileSync}from'node:fs'
import{resolve}from'node:path'
import{spawn}from'node:child_process'
const scenario=process.argv[2]
process.on('message',packet=>{
 if(packet.type!=='request')return
 let descendant
 if(['descendant','orphan-pipe'].includes(scenario))descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:scenario==='orphan-pipe'?['ignore','ignore','inherit']:'ignore'})
 writeFileSync(resolve(packet.request.cwd,'pids.json'),JSON.stringify({pid:process.pid,descendant:descendant?.pid}))
 const send=message=>process.send({type:'message',message})
 send({type:'model',event:{model:packet.request.model,choices:[{delta:{content:'complete answer'},finish_reason:'stop'}]}})
 send({type:'response_done',response:{output:[{type:'message',content:[{type:'output_text',text:'complete answer'}]}]}})
 if(scenario!=='no-complete')process.send({type:'complete'})
 if(scenario==='normal'||scenario==='orphan-pipe')process.disconnect(),setImmediate(()=>process.exit(0))
 else if(scenario==='bad-exit')setImmediate(()=>process.exit(2))
 else if(scenario==='cleanup-error'){process.send({type:'failure',failure:{code:'SERVER',message:'fixture cleanup failed'}});setImmediate(()=>process.exit(0))}
 else setInterval(()=>{},1000)
})
