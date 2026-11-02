import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readImages } from '../src/images.ts'
import { requestHistory } from '../src/history.ts'
const attachment={attachmentId:'one',mediaType:'image/png',bytes:3,width:2,height:2}
const image={type:'image',attachment}
test('附件服务读取经过验证的请求图片，同一附件每次请求只读取一次',async()=>{
 let calls=0
 const options={messages:[{role:'user',content:[image]},{role:'tool',content:[image]}]}
 const store={async readImageRequest(ref,target,signal){calls++;assert.equal(ref,attachment);assert.deepEqual(target,{width:2,height:2,maxBytes:3});assert.equal(signal,undefined);return {mediaType:'image/png',data:Buffer.from('png')}}}
 const images=await readImages(options,store)
 assert.equal(calls,1)
 assert.equal(images.get('one'),'data:image/png;base64,cG5n')
})
test('已卸载图片不读取字节，并转换成 DSH 图片占位文本',async()=>{
 const options={messages:[{role:'user',content:[{...image,offloaded:true}]}]}
 const images=await readImages(options)
 assert.equal(images.size,0)
 const {input}=requestHistory(options,images)
 assert.equal(input[0].content[0].type,'input_text')
})
test('存储失败、取消和图片数量超限发生在模型请求之前',async()=>{
 const options={messages:[{role:'user',content:[image]}]}
 await assert.rejects(readImages(options),/附件服务/)
 await assert.rejects(readImages(options,{readImageRequest:async()=>{throw Error('corrupt attachment')}}),/corrupt attachment/)
 await assert.rejects(readImages({...options,signal:AbortSignal.abort()}),{name:'AbortError'})
 await assert.rejects(readImages({messages:[{role:'user',content:[image,image]}]},undefined,1),e=>e.code==='IMAGE_OFFLOAD_REQUIRED'&&e.failure.offloadImages===1)
})
