import http, { ClientRequest, IncomingMessage, Server, ServerResponse } from 'http'
import { EventEmitter, once } from 'events'
import { AddressInfo, Socket } from 'net'
import { httpPingWithRedirects } from '../utils/httpPingWithRedirects.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}

function mockRequest(): ClientRequest {
  const request = new EventEmitter() as ClientRequest
  request.destroy = jest.fn(() => request)
  return request
}

function mockResponse(statusCode: number, location?: string): IncomingMessage {
  const response = new EventEmitter() as IncomingMessage
  response.statusCode = statusCode
  response.headers = location === undefined ? {} : { location }
  response.destroy = jest.fn(() => response)
  return response
}

type ResponseCallback = (response: IncomingMessage) => void

describe('httpPingWithRedirects', () => {
  let server: Server
  let baseUrl: string
  let handler: (request: IncomingMessage, response: ServerResponse) => void
  const sockets = new Set<Socket>()

  beforeAll(async () => {
    server = http.createServer((request, response) => handler(request, response))
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  beforeEach(() => {
    handler = (_request, response) => response.end('ok')
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
    // 清理失败断言可能留下的测试连接，避免影响其它测试。
    for (const socket of sockets) socket.destroy()
  })

  afterAll(async () => {
    server.close()
    await once(server, 'close')
  })

  it('accepts HTTP 200 and sends an identifying user agent', async () => {
    let userAgent: string | undefined
    handler = (request, response) => {
      userAgent = request.headers['user-agent']
      response.end('ok')
    }

    const result = await httpPingWithRedirects(baseUrl)

    expect(result.success).toBe(true)
    expect(result.responseTime).toEqual(expect.any(Number))
    expect(userAgent).toBe('GSManager-NetworkCheck/1.0')
  })

  it('reports an HTTP 404 with its status detail', async () => {
    handler = (_request, response) => {
      response.writeHead(404)
      response.end()
    }

    await expect(httpPingWithRedirects(baseUrl)).resolves.toEqual({
      success: false,
      error: 'HTTP状态码异常: 404，期望 2xx'
    })
  })

  it('respects a custom expected status', async () => {
    handler = (_request, response) => {
      response.writeHead(204)
      response.end()
    }

    expect((await httpPingWithRedirects(baseUrl, 1000, 204)).success).toBe(true)
    await expect(httpPingWithRedirects(baseUrl, 1000, 200)).resolves.toEqual({
      success: false,
      error: 'HTTP状态码异常: 204，期望 200'
    })
  })

  it.each([301, 302, 303, 307, 308])('follows a relative HTTP %i redirect', async (status) => {
    const paths: string[] = []
    handler = (request, response) => {
      paths.push(request.url)
      if (request.url === '/path/start') {
        response.writeHead(status, { Location: '../ok' })
      }
      response.end()
    }

    expect((await httpPingWithRedirects(`${baseUrl}/path/start`)).success).toBe(true)
    expect(paths).toEqual(['/path/start', '/ok'])
  })

  it('allows five redirects and rejects a sixth without making another request', async () => {
    const paths: string[] = []
    handler = (request, response) => {
      paths.push(request.url)
      const remaining = Number(request.url.slice(1))
      if (remaining > 0) response.writeHead(302, { Location: `/${remaining - 1}` })
      response.end()
    }

    expect((await httpPingWithRedirects(`${baseUrl}/5`)).success).toBe(true)
    expect(paths).toEqual(['/5', '/4', '/3', '/2', '/1', '/0'])
    paths.length = 0
    await expect(httpPingWithRedirects(`${baseUrl}/6`)).resolves.toEqual({
      success: false,
      error: '重定向次数超过限制 (5)'
    })
    expect(paths).toEqual(['/6', '/5', '/4', '/3', '/2', '/1'])
  })

  it('bounds a redirect loop', async () => {
    let requests = 0
    handler = (_request, response) => {
      requests++
      response.writeHead(302, { Location: '/loop' })
      response.end()
    }

    expect((await httpPingWithRedirects(`${baseUrl}/loop`)).error).toMatch(/重定向次数/)
    expect(requests).toBe(6)
  })

  it('reports missing and malformed redirect locations', async () => {
    handler = (request, response) => {
      response.writeHead(302, request.url === '/missing' ? {} : { Location: 'http://[::1' })
      response.end()
    }

    expect((await httpPingWithRedirects(`${baseUrl}/missing`)).error).toMatch(/缺少 Location/)
    expect((await httpPingWithRedirects(`${baseUrl}/malformed`)).error).toMatch(/无效的重定向地址/)
  })

  it('rejects non-HTTP protocols initially and after a redirect', async () => {
    handler = (_request, response) => {
      response.writeHead(302, { Location: 'file:///test-file' })
      response.end()
    }

    expect((await httpPingWithRedirects('file:///test-file')).error).toMatch(/不支持的 URL 协议/)
    expect((await httpPingWithRedirects(baseUrl)).error).toMatch(/不支持的 URL 协议/)
  })

  it('shares one deadline across all redirect hops', async () => {
    jest.useFakeTimers()
    const callbacks: ResponseCallback[] = []
    const requests: ClientRequest[] = []
    jest.spyOn(http, 'get').mockImplementation((_url, _options, callback) => {
      callbacks.push(callback)
      const request = mockRequest()
      requests.push(request)
      return request
    })

    const pending = httpPingWithRedirects('http://example.test/start', 100)
    await jest.advanceTimersByTimeAsync(60)
    const redirect = mockResponse(307, '/next')
    callbacks[0](redirect)
    expect(requests).toHaveLength(2)
    await jest.advanceTimersByTimeAsync(40)

    await expect(pending).resolves.toEqual({ success: false, error: '连接超时 (100ms)' })
    expect(redirect.destroy).toHaveBeenCalled()
    expect(requests[0].destroy).toHaveBeenCalled()
    expect(requests[1].destroy).toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('times out a connection without response headers and closes it', async () => {
    const closed = deferred()
    handler = (_request, response) => {
      response.on('close', closed.resolve)
    }

    await expect(httpPingWithRedirects(baseUrl, 1000)).resolves.toEqual({
      success: false,
      error: '连接超时 (1000ms)'
    })
    await closed.promise
  })

  it('follows a redirect without waiting for an unfinished response body', async () => {
    const closed = deferred()
    handler = (request, response) => {
      if (request.url === '/start') {
        response.on('close', closed.resolve)
        response.writeHead(307, { Location: '/ok' })
        response.flushHeaders()
      } else {
        response.end('ok')
      }
    }

    expect((await httpPingWithRedirects(`${baseUrl}/start`)).success).toBe(true)
    await closed.promise
  })

  it('stops an unfinished successful response body after receiving headers', async () => {
    const closed = deferred()
    handler = (_request, response) => {
      response.on('close', closed.resolve)
      response.writeHead(200)
      response.flushHeaders()
    }

    expect((await httpPingWithRedirects(baseUrl)).success).toBe(true)
    await closed.promise
  })

  it('applies the deadline before a socket or DNS result is available', async () => {
    jest.useFakeTimers()
    const request = mockRequest()
    jest.spyOn(http, 'get').mockReturnValue(request)

    const pending = httpPingWithRedirects('http://unresolved.invalid/', 100)
    await jest.advanceTimersByTimeAsync(100)

    await expect(pending).resolves.toEqual({ success: false, error: '连接超时 (100ms)' })
    expect(request.destroy).toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('ignores late errors from a retired redirect hop', async () => {
    const callbacks: ResponseCallback[] = []
    const requests: ClientRequest[] = []
    jest.spyOn(http, 'get').mockImplementation((_url, _options, callback) => {
      callbacks.push(callback)
      const request = mockRequest()
      requests.push(request)
      return request
    })

    const pending = httpPingWithRedirects('http://example.test/start')
    const redirect = mockResponse(307, '/ok')
    callbacks[0](redirect)
    requests[0].emit('error', new Error('retired request'))
    redirect.emit('error', new Error('retired response'))
    const response = mockResponse(200)
    callbacks[1](response)

    await expect(pending).resolves.toEqual({ success: true, responseTime: expect.any(Number) })
    requests[1].emit('error', new Error('already settled'))
    expect(response.destroy).toHaveBeenCalled()
    expect(requests[1].destroy).toHaveBeenCalled()
  })

  it('leaves no open connection after a successful probe', async () => {
    const closed = deferred()
    handler = (request, response) => {
      request.socket.on('close', closed.resolve)
      response.writeHead(200)
      response.flushHeaders()
    }

    expect((await httpPingWithRedirects(baseUrl)).success).toBe(true)
    await closed.promise
    expect(sockets.size).toBe(0)
  })
})
