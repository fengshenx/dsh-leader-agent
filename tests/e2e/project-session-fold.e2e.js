/**
 * 项目树会话列表的水位：默认露 5 条，展开其余后收起项目、再展开回到 5 条。
 *
 * 两段起实例（同 `projects.json` / `workers.json` 的惯例）：第一段让宿主里真实
 * 建出 leader 与 6 个 worker 会话并各跑一轮 mock，停掉后把会话登记进项目；第二段
 * 验证「展开 → 收起项目 → 再展开」之后水位回到默认一页，而不是保留上次展开的
 * 6 条。断言只落在插件自己的 DOM（会话行数与「展开其余」按钮文案）上。
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
  leader: 'MOCK-FOLD-LEADER',
  workers: ['MOCK-FOLD-W1', 'MOCK-FOLD-W2', 'MOCK-FOLD-W3', 'MOCK-FOLD-W4', 'MOCK-FOLD-W5', 'MOCK-FOLD-W6'],
}

const LEADER_REPLY = '折叠场景：leader 已就位。'
const WORKER_REPLIES = M.workers.map((_, index) => `折叠场景：worker ${index + 1} 回执。`)

/** 默认水位一页的条数，与 `SESSION_WATERMARK_BASE` 一致。 */
const PAGE_SIZE = 5

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

/** 写项目与 worker 登记表：项目树只列登记过的 worker。 */
function seed(home, leader, workers) {
  mkdirSync(join(home, 'dsh-leader-agent'), { recursive: true })
  const now = Date.now()
  writeFileSync(join(home, 'dsh-leader-agent', 'projects.json'), `${JSON.stringify({
    version: 1,
    projects: [{
      id: 'fold-project',
      name: '折叠项目',
      directory: leader.cwd,
      leaderSessionId: leader.id,
      createdAt: now,
      updatedAt: now,
    }],
  }, null, 2)}\n`)
  writeFileSync(join(home, 'dsh-leader-agent', 'workers.json'), `${JSON.stringify({
    version: 1,
    workers: workers.map((worker) => ({
      childId: worker.id,
      parentSessionId: leader.id,
      name: worker.name,
      registeredAt: now,
    })),
  }, null, 2)}\n`)
}

test('收起项目再展开，会话列表回到默认 5 条', { timeout: scenarioTimeout(180_000) }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-project-fold-'))
  const problems = []
  const scripts = {
    [M.leader]: [{ text: LEADER_REPLY }],
    ...Object.fromEntries(M.workers.map((marker, index) => [marker, [{ text: WORKER_REPLIES[index] }]])),
  }
  const mock = await startMockProvider({ scripts })
  let browser = null
  let instance = null

  t.after(() => stopScenario({ browser, instance, mock, root }))

  // 第一段：建 leader + 6 个 worker 会话（超过一页才看得出水位有没有被带回来）。
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
  await composer.fill(`${M.leader} 安排一下折叠场景。`)
  await composer.press('Enter')
  await waitForLocator(bootstrap.getByText(LEADER_REPLY).first(), { description: 'leader 回复上屏' })

  const workspaceRow = bootstrap.locator('[data-row-key^="workspace:"]').filter({ hasText: '默认工作区' }).first()
  await waitForLocator(workspaceRow, { description: '默认工作区行', timeoutMs: 20_000 })
  const workers = []
  for (let index = 0; index < M.workers.length; index += 1) {
    const marker = M.workers[index]
    // 宿主的「新建会话」会复用同工作区里的空白草稿；上一条已经跑过一轮，
    // 这里才会真的建出新会话。
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
    await composer.fill(`${marker} 收工即可`)
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

  // 第二段：展开 → 展开其余 → 收起项目 → 再展开，水位应回到默认一页。
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
  // 当前会话参与水位：若宿主把第 6 个 worker 恢复成当前会话，基线本来就会
  // 露出 6 条，断言就失去意义。先把当前会话切到 leader（它不在子会话列表里）。
  await projectRow.click()
  await waitFor({
    description: '项目行进入选中态（当前会话已切到 leader）',
    check: async () => (await projectRow.getAttribute('data-selected')) === 'true',
  })

  const sessionRows = page.locator('.dsh-leader-agent-session-row')
  const overflow = page.locator('.dsh-leader-agent-session-overflow')

  await projectRow.locator('button[aria-label="展开会话"]').click()
  await waitForLocator(sessionRows.first(), { description: '展开后的第一条 worker 会话行' })
  await waitFor({
    description: `默认只露 ${PAGE_SIZE} 条会话`,
    check: async () => (await sessionRows.count()) === PAGE_SIZE,
  })
  assert.equal(await overflow.innerText(), `展开其余 1 个会话`, '默认视图应只藏 1 条，按钮给出剩余条数')

  // 展开其余：6 条全可见，按钮变成「收起」。
  await overflow.click()
  await waitFor({
    description: '展开其余后 6 条全可见',
    check: async () => (await sessionRows.count()) === workers.length,
  })
  assert.equal(await overflow.innerText(), '收起', '全部放完后按钮应变成收起')

  // 收起项目：会话列表整段卸载。
  await projectRow.locator('button[aria-label="收起会话"]').click()
  await waitFor({
    description: '收起项目后会话行全部消失',
    check: async () => (await sessionRows.count()) === 0,
  })

  // 再展开：水位必须回到默认一页，而不是保留上次展开的 6 条。
  await projectRow.locator('button[aria-label="展开会话"]').click()
  await waitForLocator(sessionRows.first(), { description: '重新展开后的第一条 worker 会话行' })
  // 第 6 条（下标等于一页条数）不该出现：失败时 locator 读数会给出它的计数与
  // 可见性，能直接分开「水位没重置」与「列表没渲染」。
  await waitForLocator(sessionRows.nth(PAGE_SIZE), {
    description: `重新展开后第 ${PAGE_SIZE + 1} 条会话行不应出现`,
    state: 'detached',
  })
  assert.equal(
    await sessionRows.count(),
    PAGE_SIZE,
    '收起再展开后应回到默认一页',
  )
  assert.equal(
    await overflow.innerText(),
    '展开其余 1 个会话',
    '收起再展开后应回到默认一页，剩余条数重新出现在「展开其余」上',
  )

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
