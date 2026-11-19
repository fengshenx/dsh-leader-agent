/**
 * worker 回报气泡的头像：真实宿主渲染出的 `<img src>` 必须是可解析的
 * `data:image/svg+xml`，带白名单 `data-shape` 与描边。
 *
 * 回报由 e2e 直接按宿主会话日志的格式追加（source 用本仓真实的
 * `workerReportSource`），不经过模型；这条用例守的是构建产物与宿主渲染，
 * 不是 blobatar 的几何计算（后者归单测）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { startInstanceIn } from './instance.mjs'
import { scenarioTimeout, stopScenario, waitFor, waitForLocator, watchProblems } from './harness.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { workerReportSource } from '../../src/shared/worker-report.js'

const SHAPES = ['round', 'organic', 'boxy', 'droplet', 'hexagon']

/**
 * 从数据根里取第一个会话的 id 与 cwd。
 * @param {string} home - 实例数据根
 * @returns {{ id: string, cwd: string } | null} 会话身份
 */
function firstSession(home) {
  for (const text of readSessionLogs(home)) {
    const line = text.split('\n').find(Boolean)
    if (line === undefined) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'session' && typeof event.id === 'string' && typeof event.cwd === 'string') {
        return { id: event.id, cwd: event.cwd }
      }
    } catch {
      // 正在写的日志可能读到半行；下一份再看。
    }
  }
  return null
}

/**
 * 把 leader 会话登记成项目。
 * @param {string} home - 实例数据根
 * @param {{ id: string, cwd: string }} session - leader 会话
 * @returns {void}
 */
function seedProject(home, session) {
  mkdirSync(join(home, 'dsh-leader-agent'), { recursive: true })
  writeFileSync(join(home, 'dsh-leader-agent', 'projects.json'), `${JSON.stringify({
    version: 1,
    projects: [{
      id: 'e2e-avatar-project',
      name: 'avatar',
      directory: session.cwd,
      leaderSessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

/**
 * 追加一条 worker 回报事件并重新压缩日志。
 * @param {string} home - 实例数据根
 * @param {{ id: string, cwd: string }} session - leader 会话
 * @returns {void}
 */
function appendWorkerReport(home, session) {
  const path = join(
    home,
    'sessions',
    `--${session.cwd.slice(1).replaceAll('/', '-')}--`,
    session.id,
    'session.v4.jsonl.zstd',
  )
  const compressed = readFileSync(path)
  const lines = zstdDecompressSync(compressed).toString('utf8').split('\n').filter(Boolean)
  const maxSeq = Math.max(...lines.map((line) => JSON.parse(line).seq ?? 0))
  const source = workerReportSource('avatar-worker', 'child-1', '任务「avatar-worker」已结束。', '改完了', 'completed')
  const event = {
    type: 'user/message',
    seq: maxSeq + 1,
    time: Date.now(),
    data: {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: '任务「avatar-worker」已结束。\n产物摘要：\n改完了' }],
      source,
    },
    surfaceOp: 'append',
  }
  const frame = zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
  writeFileSync(path, Buffer.concat([compressed, frame]))
}

test('worker 回报气泡的头像是可解析的 blobatar data URI', { timeout: scenarioTimeout() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-avatar-'))
  const mock = await startMockProvider({})
  const problems = []
  let browser = null
  let instance = null
  t.after(() => stopScenario({ browser, instance, mock, root }))

  instance = await startInstanceIn({ root, baseUrl: mock.url })
  browser = await chromium.launch()
  let page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  watchProblems(page, problems)
  await page.goto(instance.url, { waitUntil: 'domcontentloaded' })
  await waitForLocator(page.locator('div[role="textbox"][contenteditable="true"]').first(), {
    description: '输入框可编辑',
    timeoutMs: 20_000,
  })
  const session = await waitFor({
    description: '宿主启动后落盘一个空会话',
    check: () => firstSession(instance.home),
    timeoutMs: 5_000,
  })
  await page.close()
  await instance.stop({ keepRoot: true })

  seedProject(instance.home, session)
  appendWorkerReport(instance.home, session)

  instance = await startInstanceIn({ root, baseUrl: mock.url })
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  watchProblems(page, problems)
  await page.goto(instance.url, { waitUntil: 'domcontentloaded' })
  await waitForLocator(page.getByText('avatar').first(), { description: '项目行', timeoutMs: 15_000 })
  await page.getByText('avatar').first().click()
  await waitForLocator(page.locator('.dsh-leader-agent-agent-bubble').first(), {
    description: 'worker 回报气泡',
    timeoutMs: 15_000,
  })

  const src = await page.locator('.dsh-leader-agent-agent-bubble__avatar').first().getAttribute('src')
  assert.equal(typeof src, 'string')
  assert.equal(src.startsWith('data:image/svg+xml,'), true)
  const svg = decodeURIComponent(src.slice('data:image/svg+xml,'.length))
  const shape = /data-shape="([^"]+)"/.exec(svg)?.[1]
  assert.ok(SHAPES.includes(shape), `data-shape 不在白名单：${shape}`)
  assert.match(svg, /stroke-width="2\.5"/)
  assert.equal(svg.includes('avatar-worker'), false)
  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
