/**
 * 项目树里的 worker 按「最近被使用」排：登记表的 `lastUsedAt` 越大越靠前。
 *
 * 两段起实例：第一段让宿主真实建出 leader 与 3 个 worker 并各跑一轮 mock，停掉后
 * 写项目与登记表——登记表的最后使用时间故意与创建顺序相反；第二段从项目行展开，
 * 断言会话行的顺序按时间而不是按会话库的创建顺序。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { startInstanceIn } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { scenarioTimeout, stopScenario, waitFor, waitForLocator, watchProblems } from './harness.mjs'

const M = {
  leader: 'MOCK-ORDER-LEADER',
  workers: ['MOCK-ORDER-W1', 'MOCK-ORDER-W2', 'MOCK-ORDER-W3'],
}

const LEADER_REPLY = '排序场景：leader 已就位。'
const WORKER_REPLIES = M.workers.map((_, index) => `排序场景：worker ${index + 1} 回执。`)

/** 从数据根里取宿主启动时建的第一个会话。 */
function firstSession(home) {
  for (const text of readSessionLogs(home)) {
    const line = text.split('\n').find((item) => item !== '')
    if (line === undefined) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'session' && typeof event.id === 'string' && typeof event.cwd === 'string') {
        return { id: event.id, cwd: event.cwd }
      }
    } catch { continue }
  }
  return null
}

/** 读页面上当前被选中的宿主会话 id。 */
async function currentSessionId(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-row-key^="session:"][aria-selected="true"]')
    return row?.getAttribute('data-row-key')?.slice('session:'.length) ?? null
  })
}

/** 首次打开宿主会弹「预览版说明」，不关掉会挡住输入框。 */
async function dismissWelcome(page) {
  const button = page.getByRole('dialog').getByRole('button', { name: '继续' })
  try { await button.click({ timeout: 4000 }) } catch { /* 没弹窗就继续 */ }
}

/**
 * 写项目与 worker 登记表。
 *
 * `lastUsedAt` 与创建顺序相反：w1 建得最早、最后使用时间最新。会话库按创建时间
 * 倒序给 [w3, w2, w1]，排序正确时会看到 [w1, w2, w3]。
 *
 * @param {string} home - 数据根
 * @param {object} leader - leader 会话
 * @param {object[]} workers - worker 会话（按创建顺序）
 * @returns {void}
 */
function seed(home, leader, workers) {
  mkdirSync(join(home, 'dsh-leader-agent'), { recursive: true })
  const now = Date.now()
  writeFileSync(join(home, 'dsh-leader-agent', 'projects.json'), `${JSON.stringify({
    version: 1,
    projects: [{
      id: 'order-project',
      name: '排序项目',
      directory: leader.cwd,
      leaderSessionId: leader.id,
      createdAt: now,
      updatedAt: now,
    }],
  }, null, 2)}\n`)
  writeFileSync(join(home, 'dsh-leader-agent', 'workers.json'), `${JSON.stringify({
    version: 1,
    workers: workers.map((worker, index) => ({
      childId: worker.id,
      parentSessionId: leader.id,
      name: worker.name,
      registeredAt: now - (workers.length - index) * 10_000,
      lastUsedAt: now - index * 1_000,
    })),
  }, null, 2)}\n`)
}

test('项目树的 worker 按最后使用时间倒序排列', { timeout: scenarioTimeout(180_000) }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-worker-order-'))
  const problems = []
  const scripts = {
    [M.leader]: [{ text: LEADER_REPLY }],
    ...Object.fromEntries(M.workers.map((marker, index) => [marker, [{ text: WORKER_REPLIES[index] }]])),
  }
  const mock = await startMockProvider({ scripts })
  let browser = null
  let instance = null

  t.after(() => stopScenario({ browser, instance, mock, root }))

  // 第一段：建 leader + 3 个 worker（按 w1 → w2 → w3 的顺序）。
  const first = await startInstanceIn({ root, baseUrl: mock.url })
  instance = first
  browser = await chromium.launch()
  const bootstrapContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const bootstrap = await bootstrapContext.newPage()
  watchProblems(bootstrap, problems)
  await bootstrap.goto(first.url, { waitUntil: 'domcontentloaded' })
  const composer = bootstrap.locator('div[role="textbox"][contenteditable="true"]').first()
  await waitForLocator(composer, { description: '第一段输入框', timeoutMs: 20_000 })
  await dismissWelcome(bootstrap)
  const leader = await waitFor({
    description: '宿主启动后落盘一个会话',
    check: () => firstSession(first.home),
    timeoutMs: 5_000,
  })
  await composer.click()
  await composer.fill(`${M.leader} 准备三个 worker。`)
  await composer.press('Enter')
  await waitForLocator(bootstrap.getByText(LEADER_REPLY).first(), { description: 'leader 回复上屏' })

  const workspaceRow = bootstrap.locator('[data-row-key^="workspace:"]').filter({ hasText: '默认工作区' }).first()
  await waitForLocator(workspaceRow, { description: '默认工作区行', timeoutMs: 20_000 })
  const workers = []
  for (let index = 0; index < M.workers.length; index += 1) {
    await workspaceRow.hover()
    await workspaceRow.locator('button[aria-label*="新建会话"]').first().click({ force: true })
    const id = await waitFor({
      description: `新建第 ${index + 1} 个 worker 会话`,
      check: async () => {
        const current = await currentSessionId(bootstrap)
        return typeof current === 'string' && current !== leader.id && !workers.some((item) => item.id === current)
          ? current
          : null
      },
      timeoutMs: 15_000,
    })
    await composer.click()
    await composer.fill(`${M.workers[index]} 收工即可`)
    await composer.press('Enter')
    await waitForLocator(bootstrap.getByText(WORKER_REPLIES[index]).first(), {
      description: `第 ${index + 1} 个 worker 的回复上屏`,
    })
    workers.push({ id, name: `worker-${index + 1}` })
  }
  await bootstrapContext.close()
  await first.stop({ keepRoot: true })
  instance = null

  seed(first.home, leader, workers)

  // 第二段：展开项目，按 DOM 顺序读会话行 id。
  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watchProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })
  await waitForLocator(page.locator('div[role="textbox"][contenteditable="true"]').first(), {
    description: '第二段输入框',
    timeoutMs: 20_000,
  })
  await dismissWelcome(page)

  const projectRow = page.locator('.dsh-leader-agent-project-row').first()
  await waitForLocator(projectRow, { description: '项目行', timeoutMs: 20_000 })
  await projectRow.locator('button[aria-label="展开会话"]').click()

  const sessionRows = page.locator('.dsh-leader-agent-session-row')
  await waitFor({
    description: '三个 worker 会话行都出现',
    check: async () => (await sessionRows.count()) === workers.length,
  })
  const rendered = await sessionRows.evaluateAll((nodes) => nodes.map((node) => node.dataset.sessionId))
  assert.deepEqual(
    rendered,
    [workers[0].id, workers[1].id, workers[2].id],
    '最近被使用的 worker 应排在最前（w1 的最后使用时间最新）',
  )

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
