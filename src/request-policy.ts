import { LlmError } from '@deepseek-ai/dsh-llm'

// 官方 HTTP 宿主策略在发送前限制模型请求，防止 SDK 截断恢复绕过 DSH 步骤。
export function requestPolicy(controller: AbortController) {
  let requests = 0
  let failure: LlmError | undefined
  return {
    get failure() { return failure },
    resolve(url: string, environment: Readonly<NodeJS.ProcessEnv>) {
      const target = new URL(url)
      if (/\/(chat\/completions|messages|responses)\/?$/.test(target.pathname) && ++requests > 1) {
        failure ??= new LlmError('SDK 尝试追加模型请求，插件已阻止；本次生成未完成，请重试。上游原始错误不可用。', 'CODEBUDDY_RETRY_BLOCKED')
        controller.abort()
        throw failure
      }
      const proxyUrl = target.protocol === 'https:'
        ? environment.https_proxy ?? environment.HTTPS_PROXY ?? environment.all_proxy ?? environment.ALL_PROXY ?? environment.http_proxy ?? environment.HTTP_PROXY
        : environment.http_proxy ?? environment.HTTP_PROXY ?? environment.all_proxy ?? environment.ALL_PROXY
      return { proxyUrl, noProxy: environment.no_proxy ?? environment.NO_PROXY }
    },
  }
}
