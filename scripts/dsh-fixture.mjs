import { mkdirSync,writeFileSync,symlinkSync,readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
export function createProfile({home,root,name,patch='',budgetFile,captureRequests=false}){
 const profile=resolve(home,'profiles',name),control=resolve(profile,'node_modules/dsh-test-control')
 mkdirSync(control,{recursive:true})
 try{symlinkSync(root,resolve(profile,'node_modules/dsh-codebuddy-sdk'),'dir')}catch(error){if(error.code!=='EEXIST')throw error}
 writeFileSync(resolve(profile,'package.json'),JSON.stringify({private:true,type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-sdk-app','dsh-codebuddy-sdk']}}}))
 writeFileSync(resolve(control,'package.json'),JSON.stringify({name:'dsh-test-control',version:'0.0.0',type:'module',main:'index.mjs'}))
 writeFileSync(resolve(control,'index.mjs'),`export {inject,apply} from ${JSON.stringify(pathToFileURL(resolve(root,'scripts/compaction-control.mjs')).href)}\n`)
 const portFile=resolve(home,`${name}.port`)
 writeFileSync(resolve(profile,'cordis.patch.yml'),`- id: session-title-llm\n  disabled: true\n- id: compaction-basic\n  config:\n    maxTokens: 256\n- insert:\n    - id: test-control\n      name: dsh-test-control\n      config:\n        portFile: ${JSON.stringify(portFile)}\n        captureRequests: ${captureRequests}\n${budgetFile?`        budgetFile: ${JSON.stringify(budgetFile)}\n`:''}${patch}`)
 return {profile,portFile}
}
export async function control(portFile,sessionId,action='compact'){
 const port=Number(readFileSync(portFile,'utf8'))
 const response=await fetch(`http://127.0.0.1:${port}/`,{method:'POST',body:JSON.stringify({sessionId,action}),signal:AbortSignal.timeout(65000)})
 const result=await response.json()
 if(!response.ok)throw new Error(result.error)
 return result
}
