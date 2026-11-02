import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { LlmError, requiredImageOffload } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

export async function readImages(options: GenerateOptions, attachments?: AttachmentStore, maxImages?: number): Promise<ReadonlyMap<string, string>> {
  const offload = requiredImageOffload(options.messages, { representation: 'base64', maxImages }, () => 0)
  if (offload) throw new LlmError('CodeBuddy 模型的图片数量超过限制，请卸载较早的图片', 'IMAGE_OFFLOAD_REQUIRED', { offloadImages: offload })
  const images = new Map<string, string>()
  for (const message of options.messages) for (const block of message.content) {
    if (block.type !== 'image' || block.offloaded) continue
    options.signal?.throwIfAborted()
    if (!attachments) throw new LlmError('图片需要 DSH 附件服务', 'CODEBUDDY_UNSUPPORTED')
    const ref = block.attachment
    if (!ref) throw new LlmError('图片缺少附件引用', 'INVALID_REQUEST')
    if (images.has(ref.attachmentId)) continue
    const version = await attachments.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: ref.bytes }, options.signal)
    images.set(ref.attachmentId, `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`)
  }
  return images
}
