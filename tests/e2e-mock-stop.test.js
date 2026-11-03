import assert from 'node:assert/strict'
import { Agent, request } from 'node:http'
import { test } from 'node:test'
import { startMockProvider } from './e2e/mock-llm.mjs'

/**
 * 发一个只写了半截请求体的 POST，连接一直处于活动状态。
 *
 * 实例被杀前模型请求可能正在流式进行；`server.close()` 会等这类连接结束，mock 的
 * `stop()` 于是挂住，清理阶段再也走不到删数据根——全量 e2e 偶发卡几分钟即此形态。
 */
function startSlowPost(mock) {
  const agent = new Agent({ keepAlive: true })
  const url = new URL('/v1/messages', mock.url)
  const req = request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    agent,
    headers: { 'content-type': 'application/json' },
  }, (res) => res.resume())
  req.on('error', () => {})
  req.write('{"model":"mock-model","messages":')
  return { req, agent }
}

test('stop 不等未结束的请求：活动连接要被直接掐掉', async () => {
  const mock = await startMockProvider({ scripts: {} })
  const { req, agent } = startSlowPost(mock)
  try {
    // 等连接确实建立并打到 mock 的 handler 上。
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = Date.now()
    const finished = mock.stop().then(() => true, () => true)
    const inBudget = await Promise.race([
      finished,
      new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
    ])
    assert.equal(inBudget, true, `stop 超过 2 秒未完成（${Date.now() - started}ms），仍在等未结束的请求`)
  } finally {
    req.destroy()
    agent.destroy()
  }
})

test('stop 幂等：没起过监听或已停过都能直接返回', async () => {
  const mock = await startMockProvider({ scripts: {} })
  await mock.stop()
  await mock.stop()
})
