/**
 * worker 回报气泡：头像渲染成带白名单 `data-shape` 的内联 SVG，恶意 name 不进入
 * SVG，长正文默认折叠、可展开收起。
 *
 * 只断言 DOM、可访问性属性与折叠状态；SVG 几何、描边宽度与眨眼动画属于样式，
 * 不写进 e2e（走人工取证）。
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
import { openProject, scenarioTimeout, stopScenario, waitFor, waitForLocator, watchProblems } from './harness.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { workerReportSource } from '../../src/shared/worker-report.js'

const SHAPES = ['round', 'organic', 'boxy', 'droplet', 'hexagon']
const MALICIOUS = '<img src=x onerror="alert(1)">'

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
  // 第三条故意写长：正文超过两行才会出现「展示更多」；折叠水位由气泡在 layout
  // effect 里同步量一次，之后的宽度变化由 ResizeObserver 重算。
  const longSummary = '改动与验证读数：' + '单测 12 条、e2e 1 条、双向验证通过。'.repeat(8)
  const reports = [
    ['avatar-worker', 'child-1', '任务「avatar-worker」已结束。', '改完了'],
    [MALICIOUS, 'child-2', '任务「恶意 name」已结束。', '第二个头像'],
    ['long-worker', 'child-3', '任务「long-worker」已结束。', longSummary],
  ]
  const frames = reports.map(([name, childId, report, summary], index) => {
    const source = workerReportSource(name, childId, report, summary, 'completed')
    const event = {
      type: 'user/message',
      seq: maxSeq + index + 1,
      time: Date.now(),
      data: {
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `${report}\n产物摘要：\n${summary}` }],
        source,
      },
      surfaceOp: 'append',
    }
    return zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`), {
      params: { [constants.ZSTD_c_checksumFlag]: 1 },
    })
  })
  writeFileSync(path, Buffer.concat([compressed, ...frames]))
}

test('worker 回报气泡：头像内联 SVG、恶意 name 不注入、长正文折叠', { timeout: scenarioTimeout() }, async (t) => {
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
  // 不再用 getByText('avatar')：文本 locator 可能命中项目标题之外的同名片段，
  // 也没有就绪/选中确认。先绑到项目行，再由 openProject 等就绪并点到选中。
  const projectRow = page.locator('.dsh-leader-agent-project-row').filter({ hasText: 'avatar' }).first()
  await openProject(page, { row: projectRow, description: '项目行 avatar', timeoutMs: 20_000 })
  await waitForLocator(page.locator('.dsh-leader-agent-agent-bubble').first(), {
    description: 'worker 回报气泡',
    timeoutMs: 15_000,
  })

  const avatars = page.locator('.dsh-leader-agent-agent-bubble__avatar')
  await waitForLocator(avatars.nth(1), { description: '同屏第二个 worker 头像', timeoutMs: 10_000 })
  assert.equal(await avatars.count() >= 2, true)

  const avatar = avatars.first()
  const svg = avatar.locator('svg').first()
  assert.equal(await avatar.locator('img').count(), 0, '头像不应再是 <img>')
  assert.equal(await avatar.getAttribute('aria-hidden'), 'true')
  assert.equal(await svg.getAttribute('focusable'), 'false')
  const shape = await svg.getAttribute('data-shape')
  assert.ok(SHAPES.includes(shape), `data-shape 不在白名单：${shape}`)

  const body = svg.locator('g').first()
  assert.ok(await body.locator('path').count() >= 1, '身体组至少有一条非空 path')
  assert.equal((await svg.innerHTML()).includes('avatar-worker'), false)

  const maliciousSvg = avatars.nth(1).locator('svg').first()
  assert.equal((await maliciousSvg.innerHTML()).includes('onerror'), false, '恶意 name 不应进入 SVG')
  assert.equal((await maliciousSvg.getAttribute('data-shape')) !== null, true)

  // 折叠水位在首次测量时得出：长正文首帧就该是两行，并带「展示更多」。
  const longBubble = page.locator('.dsh-leader-agent-agent-bubble').nth(2)
  const longToggle = longBubble.locator('.dsh-leader-agent-agent-bubble__toggle')
  await waitForLocator(longToggle, { description: '长回报给「展示更多」', timeoutMs: 10_000 })
  const longContent = longBubble.locator('.dsh-leader-agent-agent-bubble__content')
  assert.equal(await longContent.getAttribute('data-collapsed'), 'true')
  await longToggle.click()
  await waitFor({
    description: '正文展开（data-collapsed 移除）',
    check: async () => (await longContent.getAttribute('data-collapsed')) === null,
    timeoutMs: 5_000,
  })
  assert.equal(await longToggle.getAttribute('aria-expanded'), 'true')
  await longToggle.click()
  await waitFor({
    description: '正文收回（data-collapsed 回来）',
    check: async () => (await longContent.getAttribute('data-collapsed')) === 'true',
    timeoutMs: 5_000,
  })

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
