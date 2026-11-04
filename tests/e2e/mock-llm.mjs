/**
 * 无密钥的 Messages mock provider：把模型这一层换成按标记驱动的脚本。
 *
 * 为什么不直接用宿主的 `@deepseek-ai/dsh-llm-mock-server`：那是恢复行为脚本
 * （限流、断连、部分文本），按请求序号出行为，不能按 prompt 里的场景标记返回
 * 指定的工具调用序列——而派工与看板场景要的正是「这条输入必须触发这次工具调用」。
 *
 * 只实现 `POST /v1/messages`：`DEEPSEEK_BASE_URL` 指向非官方端点时，宿主不探测
 * 模型列表（`packages/llm/llm-deepseek/README.md`），其余路径收到 404 并记录，
 * 便于诊断「请求打到了别处」。
 *
 * @module dsh-leader-agent/tests/e2e/mock-llm
 */

import { createServer } from 'node:http'
import { once } from 'node:events'
import { classifyRequest, createScriptCursor, resolveMarker, sseEvents } from './mock-script.mjs'

/** Messages 端点：base URL 由环境变量给出，宿主自己拼这一段。 */
const MESSAGES_PATH = '/v1/messages'

/** 标题生成请求的固定回执：它属于主机自己的附带调用，不参与场景断言。 */
const TITLE_REPLY = 'e2e 会话'

/**
 * 读完请求体。
 *
 * @param {import('node:http').IncomingMessage} request - 请求
 * @returns {Promise<string>} 原始文本
 */
async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 起一个 mock provider。
 *
 * @param {object} options - 选项
 * @param {Record<string, object[]>} options.scripts - 场景标记到步骤列表的映射
 * @returns {Promise<{ url: string, port: number, requests: object[], remaining: () => Record<string, number>, stop: () => Promise<void> }>}
 *   base URL、端口、已收到的请求、脚本剩余步数与幂等停止函数
 */
export async function startMockProvider({ scripts }) {
  const cursor = createScriptCursor(scripts)
  const requests = []

  const server = createServer(async (request, response) => {
    // 回包途中对端断开时 write/end 会触发 response 的 error 事件；没人监听就是进程级崩溃。
    response.on('error', () => {})
    let body
    try {
      body = await readBody(request)
    } catch (_aborted) {
      // 请求体传到一半连接断了（实例被 SIGTERM、客户端重连）：mock 没有可回答的
      // 请求，安静收场。让它以 unhandled rejection 退出会把整轮测试打成「看不懂的
      // crash」，掩盖真正的断言失败。
      response.destroy()
      return
    }
    const record = { method: request.method, path: request.url, body }
    requests.push(record)

    /** 打错端点是常见故障，回一份能直接看懂的 JSON 而不是空的 404。 */
    const fail = (status, message) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'mock_provider_error', message } }))
    }

    if (request.method !== 'POST' || request.url !== MESSAGES_PATH) {
      fail(404, `mock provider 只实现 POST ${MESSAGES_PATH}，收到 ${request.method} ${request.url}`)
      return
    }

    let parsed
    let step
    try {
      parsed = JSON.parse(body)
      const kind = classifyRequest(parsed)
      record.kind = kind
      step = kind === 'title' ? { text: TITLE_REPLY } : cursor.take(resolveMarker(parsed))
    } catch (error) {
      fail(400, error.message)
      return
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    response.flushHeaders()
    for (const event of sseEvents(step, { model: parsed?.model })) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    response.end()
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    remaining: cursor.remaining,
    async stop() {
      if (!server.listening) return
      // SSE 是 keep-alive：实例没断开的连接会让 `close()` 一直等下去，清理阶段于是挂住。
      // 先发起关闭再掐掉连接，回调才有机会落地。
      const closed = new Promise((resolve) => server.close(resolve))
      server.closeAllConnections()
      await closed
    },
  }
}
