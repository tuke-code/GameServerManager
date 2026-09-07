import http, { ClientRequest, IncomingMessage } from 'http'
import https from 'https'
import { URL } from 'url'

export interface HttpPingResult {
  success: boolean
  responseTime?: number
  error?: string
}

/**
 * 检测显式启用重定向的 HTTP 目标，整个跳转链共享一个总超时。
 * 只读取响应头测量连接延迟，结束后关闭响应和连接，避免继续下载响应体。
 */
export function httpPingWithRedirects(
  url: string,
  timeout: number = 10000,
  expectedStatusCode?: number
): Promise<HttpPingResult> {
  return new Promise((resolve) => {
    const startTime = Date.now()
    const maxRedirects = 5
    let settled = false
    let currentRequest: ClientRequest | undefined
    let currentResponse: IncomingMessage | undefined

    const finish = (result: HttpPingResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      currentResponse?.destroy()
      currentRequest?.destroy()
      resolve(result)
    }
    const timeoutResult = (): HttpPingResult => ({
      success: false,
      error: `连接超时 (${timeout}ms)`
    })
    const timeoutId = setTimeout(() => finish(timeoutResult()), timeout)

    const visit = (target: string, redirectCount: number): void => {
      if (settled) return
      if (Date.now() - startTime >= timeout) {
        finish(timeoutResult())
        return
      }

      try {
        const parsedUrl = new URL(target)
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          finish({ success: false, error: `不支持的 URL 协议: ${parsedUrl.protocol}` })
          return
        }
        const protocol = parsedUrl.protocol === 'https:' ? https : http
        const request = protocol.get(parsedUrl.toString(), {
          headers: { 'User-Agent': 'GSManager-NetworkCheck/1.0' }
        }, (response) => {
          if (settled || request !== currentRequest) {
            response.on('error', () => {})
            response.destroy()
            return
          }
          currentResponse = response
          response.on('error', (error: Error) => {
            if (!settled && request === currentRequest) {
              finish({ success: false, error: error.message })
            }
          })
          if (Date.now() - startTime >= timeout) {
            finish(timeoutResult())
            return
          }

          const statusCode = response.statusCode ?? 0
          if ([301, 302, 303, 307, 308].includes(statusCode)) {
            const location = response.headers.location
            if (!location) {
              finish({ success: false, error: `HTTP 重定向缺少 Location: ${statusCode}` })
              return
            }
            if (redirectCount >= maxRedirects) {
              finish({ success: false, error: `重定向次数超过限制 (${maxRedirects})` })
              return
            }
            let nextUrl: URL
            try {
              nextUrl = new URL(location, parsedUrl)
            } catch (error) {
              finish({ success: false, error: `无效的重定向地址: ${getErrorMessage(error)}` })
              return
            }
            if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
              finish({ success: false, error: `不支持的 URL 协议: ${nextUrl.protocol}` })
              return
            }
            // 先结束当前跳，防止关闭旧连接产生的异步错误影响后续请求。
            currentRequest = undefined
            currentResponse = undefined
            response.destroy()
            request.destroy()
            visit(nextUrl.toString(), redirectCount + 1)
            return
          }

          const isStatusValid = expectedStatusCode !== undefined
            ? statusCode === expectedStatusCode
            : statusCode >= 200 && statusCode < 300
          if (isStatusValid) {
            finish({ success: true, responseTime: Date.now() - startTime })
            return
          }
          const expectedLabel = expectedStatusCode !== undefined
            ? `，期望 ${expectedStatusCode}` : '，期望 2xx'
          finish({ success: false, error: `HTTP状态码异常: ${statusCode}${expectedLabel}` })
        })
        currentRequest = request
        request.on('error', (error: Error) => {
          if (!settled && request === currentRequest) {
            finish({ success: false, error: error.message })
          }
        })
      } catch (error) {
        finish({ success: false, error: getErrorMessage(error) })
      }
    }

    visit(url, 0)
  })
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
