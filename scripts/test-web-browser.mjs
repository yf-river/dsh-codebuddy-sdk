// 可选的本机 Playwright 浏览器验收；先运行 test-web.mjs，整个模型端使用虚拟凭据。
import assert from'node:assert/strict'
import{readFileSync,writeFileSync}from'node:fs'
import{resolve,dirname}from'node:path'
import{fileURLToPath}from'node:url'
const{chromium}=await import(process.env.DSH_PLAYWRIGHT_MODULE??'/usr/local/lib/node_modules/playwright/index.mjs')
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,process.env.DSH_WEB_TEST_OUTPUT??'artifacts/daily-web')
const state=JSON.parse(readFileSync(resolve(out,'state.json'))),url=readFileSync(resolve(out,'process.log'),'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)[0]
const context=await chromium.launchPersistentContext(resolve(state.home,'browser'),{executablePath:process.env.DSH_CHROME_PATH??'/opt/google/chrome/chrome',headless:true,timezoneId:'Asia/Shanghai',args:process.getuid?.()===0?['--no-sandbox']:[]})
if(process.env.DSH_BROWSER_LOOPBACK_ONLINE==='1')await context.addInitScript(()=>Object.defineProperty(Navigator.prototype,'onLine',{get:()=>true,configurable:true}))
const page=context.pages()[0],checks=[],network=[],consoleErrors=[],requestFailures=[]
page.on('response',async r=>{const path=new URL(r.url()).pathname;if(path.startsWith('/api')){const item={path,status:r.status()};network.push(item);if(['/api/session/create','/api/session/prompt'].includes(path)){item.request=r.request().postDataJSON();try{item.response=await r.json()}catch{}}}})
page.on('pageerror',e=>consoleErrors.push(e.message))
page.on('requestfailed',r=>requestFailures.push({path:new URL(r.url()).pathname,error:r.failure()?.errorText}))
const save=async name=>{writeFileSync(resolve(out,name+'.txt'),await page.locator('body').ariaSnapshot());await page.screenshot({path:resolve(out,name+'.png'),fullPage:true})}
const control=mode=>fetch(state.endpoint+'/control',{method:'POST',body:JSON.stringify({mode})})
const prompt=async text=>{await page.getByRole('textbox',{name:/^(Describe what you want to build|Message or run a task)/}).fill(text);await page.getByRole('button',{name:'Send message',exact:true}).click()}
try{
 await page.goto(url);await page.waitForTimeout(1000)
 if(await page.getByRole('button',{name:'Continue',exact:true}).count())await page.getByRole('button',{name:'Continue',exact:true}).click()
 if(await page.getByRole('textbox',{name:'Choose workspace',exact:true}).count()){
  await page.getByRole('button',{name:'Choose workspace',exact:true}).click()
  await page.getByRole('button',{name:'Edit path',exact:true}).click()
  await page.getByRole('textbox',{name:'Edit path',exact:true}).fill(state.cwd)
  await page.getByRole('textbox',{name:'Edit path',exact:true}).press('Enter')
  await page.getByRole('button',{name:'Open',exact:true}).click()
 }
 await page.getByRole('button',{name:/^New session$/i}).first().click()
 const model=page.getByRole('button',{name:/Select model, current Deepseek-V4.1-Flash/})
 await model.waitFor();await model.click();await page.getByRole('menuitem',{name:'Model Deepseek-V4.1-Flash',exact:true}).click();await page.getByText('CodeBuddy',{exact:true}).first().waitFor();await save('model-selection');await page.keyboard.press('Escape');await page.keyboard.press('Escape')
 checks.push({name:'CodeBuddy DeepSeek selectable from actual Web model picker',status:'PASS'})
 await control('text');await prompt('浏览器聊天验收：请回复准备状态。')
 await page.getByText('BROWSER_CHAT_READY',{exact:true}).last().waitFor({timeout:60000});await save('chat')
 checks.push({name:'chat streamed and rendered through actual Web UI',status:'PASS'})
 await control('tool');await prompt('浏览器工具验收：请读取 browser-fixture.txt。')
 await page.getByText('BROWSER_FILE_READY',{exact:true}).last().waitFor({timeout:60000});await save('tool')
 assert.ok(JSON.stringify(JSON.parse(readFileSync(resolve(out,'requests.json')))).includes('BROWSER_FILE_READY'))
 checks.push({name:'DSH file tool result reaches model and is rendered in Web UI',status:'PASS'})
 await control('quota');await prompt('浏览器额度不足验收。')
 await page.getByText(/Request quota exhausted/).first().waitFor({timeout:60000});await page.getByText('QUOTA',{exact:true}).first().waitFor();await save('quota')
 checks.push({name:'account quota failure is visible in actual Web UI',status:'PASS'})
 await control('refusal');await prompt('浏览器拒绝回复验收。')
 await page.getByText(/Browser fixture: request refused/).first().waitFor({timeout:60000});await save('refusal')
 checks.push({name:'refusal text is visible in actual Web UI',status:'PASS'})
 await control('text');await prompt('异常后继续聊天验收。')
 await page.getByText('BROWSER_CHAT_READY',{exact:true}).nth(1).waitFor({timeout:60000});await save('recovered')
 await page.reload();await page.getByText('BROWSER_FILE_READY',{exact:true}).last().waitFor({timeout:15000});await save('reloaded')
 checks.push({name:'chat continues after errors and browser reload restores prior messages',status:'PASS'})
}catch(error){await save('failed');checks.push({name:'browser acceptance',status:'FAILED',message:error.message});process.exitCode=1}
finally{writeFileSync(resolve(out,'browser-debug.json'),JSON.stringify({online:await page.evaluate(()=>navigator.onLine),requestFailures,network,consoleErrors,url:page.url().replace(/token=[^&]+/g,'token=REDACTED')},null,2));writeFileSync(resolve(out,'report.json'),JSON.stringify({model:'local fixture',realModelRequests:0,entry:'actual DSH Web and Chromium',browserNetworkHint:process.env.DSH_BROWSER_LOOPBACK_ONLINE==='1'?'forced-online-for-isolated-loopback':'native',checks},null,2));console.log(JSON.stringify(checks));await context.close()}
