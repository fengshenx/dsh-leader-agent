/**
 * 项目树会话列表的水位：默认露 5 条，展开其余后收起项目、再展开回到 5 条。
 *
 * 两个项目各自有一份水位：展开 A 到 6 条、收起 B 时 A 不受影响，B 回到 5；
 * 再收起 A 后重开也回到 5。两段起实例（同 `projects.json` / `workers.json` 的
 * 惯例）：第一段在两个工作区里各建一个 leader 与 6 个 worker，停掉后登记进两个
 * 项目；第二段验证隔离与回落。断言只落在插件自己的 DOM（会话行数与「展开其余」
 * 按钮文案）上。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { startInstanceIn } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { scenarioTimeout, stopScenario, waitFor, waitForLocator, watchProblems } from './harness.mjs'

/** 默认水位一页的条数，与 `SESSION_WATERMARK_BASE` 一致。 */
const PAGE_SIZE = 5
const WORKERS_PER_PROJECT = 6

const WORKSPACE_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
]

const PROJECTS = [
  {
    id: 'fold-a',
    name: '折叠项目 A',
    workspace: '项目 A 工作区',
    directory: 'project-a',
    leaderMarker: 'MOCK-FOLD-LEADER-A',
    leaderReply: '折叠场景：leader A 已就位。',
    workerMarker: (index) => `MOCK-FOLD-A-${index + 1}`,
    workerReply: (index) => `折叠场景：A worker ${index + 1} 回执。`,
  },
  {
    id: 'fold-b',
    name: '折叠项目 B',
    workspace: '项目 B 工作区',
    directory: 'project-b',
    leaderMarker: 'MOCK-FOLD-LEADER-B',
    leaderReply: '折叠场景：leader B 已就位。',
    workerMarker: (index) => `MOCK-FOLD-B-${index + 1}`,
    workerReply: (index) => `折叠场景：B worker ${index + 1} 回执。`,
  },
]

/** 读某个会话落盘的第一条 session 事件，用来核对 leader 落在对应工作区。 */
function sessionCwd(home, sessionId) {
  for (const text of readSessionLogs(home)) {
    for (const line of text.split('\n')) {
      if (line === '') continue
      try {
        const event = JSON.parse(line)
        if (event.type === 'session' && event.id === sessionId && typeof event.cwd === 'string') {
          return event.cwd
        }
      } catch { continue }
    }
  }
  return null
}

/**
 * 先种两个工作区，第一段实例才能把 leader 与 worker 建进各自的目录。
 *
 * 工作区选择器走系统目录选择，无头 Chromium 驱动不了；这里直接写宿主
 * workspace 域的落盘格式（version 2），宿主升级该域时要跟着改。
 */
function seedWorkspaces(root, dirs) {
  mkdirSync(join(root, 'home', 'storages'), { recursive: true })
  const now = new Date().toISOString()
  const tables = {}
  PROJECTS.forEach((project, index) => {
    const directory = dirs[project.id]
    mkdirSync(directory, { recursive: true })
    tables[WORKSPACE_IDS[index]] = {
      path: realpathSync(directory),
      title: project.workspace,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
  })
  writeFileSync(join(root, 'home', 'storages', 'workspace.json'), `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: WORKSPACE_IDS[0],
      workspaceIds: WORKSPACE_IDS,
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: { workspaces: tables },
  }, null, 2)}\n`)
}

/** 写项目与 worker 登记表：项目按目录归组，worker 按登记表认身份。 */
function seedProjects(home, dirs, leaders, workers) {
  mkdirSync(join(home, 'dsh-leader-agent'), { recursive: true })
  const now = Date.now()
  writeFileSync(join(home, 'dsh-leader-agent', 'projects.json'), `${JSON.stringify({
    version: 1,
    projects: PROJECTS.map((project) => ({
      id: project.id,
      name: project.name,
      directory: dirs[project.id],
      leaderSessionId: leaders.get(project.id),
      createdAt: now,
      updatedAt: now,
    })),
  }, null, 2)}\n`)
  writeFileSync(join(home, 'dsh-leader-agent', 'workers.json'), `${JSON.stringify({
    version: 1,
    workers: workers.map((worker) => ({
      childId: worker.id,
      parentSessionId: leaders.get(worker.projectId),
      name: worker.name,
      registeredAt: now,
    })),
  }, null, 2)}\n`)
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

function workspaceRow(page, title) {
  return page.locator('[data-row-key^="workspace:"]').filter({ hasText: title }).first()
}

function projectBlock(page, name) {
  return page.locator('.dsh-leader-agent-project-block').filter({
    has: page.locator('.dsh-leader-agent-project-title', { hasText: name }),
  })
}

/** 在指定工作区点「新建会话」，等到当前会话换成一个没见过的 id。 */
async function openSession(page, row, known, description, mustChange = true) {
  await row.hover()
  await row.locator('button[aria-label*="新建会话"]').first().click({ force: true })
  return waitFor({
    description,
    check: async () => {
      const sessionId = await currentSessionId(page)
      if (typeof sessionId !== 'string' || sessionId === '') return null
      if (mustChange && known.has(sessionId)) return null
      return sessionId
    },
    timeoutMs: 15_000,
  })
}

async function say(page, marker, reply, description) {
  const composer = page.locator('div[role="textbox"][contenteditable="true"]').first()
  await waitForLocator(composer, { description: `${description} 的输入框` })
  await composer.click()
  await composer.fill(marker)
  await composer.press('Enter')
  await waitForLocator(page.getByText(reply).first(), { description: `${description} 的回复上屏` })
}

/** 等插件自己的会话行数到指定值：断的是真实可见行，不是节点存在。 */
async function waitForCount(locator, count, description) {
  await waitFor({ description, check: async () => (await locator.count()) === count })
}

test('收起项目再展开回到默认 5 条，且不影响其它项目', { timeout: scenarioTimeout(180_000) }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-project-fold-'))
  const dirs = Object.fromEntries(PROJECTS.map((project) => [project.id, join(root, project.directory)]))
  seedWorkspaces(root, dirs)

  const scripts = {}
  for (const project of PROJECTS) {
    scripts[project.leaderMarker] = [{ text: project.leaderReply }]
    for (let index = 0; index < WORKERS_PER_PROJECT; index += 1) {
      scripts[project.workerMarker(index)] = [{ text: project.workerReply(index) }]
    }
  }
  const problems = []
  const mock = await startMockProvider({ scripts })
  let browser = null
  let instance = null

  t.after(() => stopScenario({ browser, instance, mock, root }))

  // 第一段：两个工作区各建一个 leader 与 6 个 worker。水位超过一页才看得出
  // 有没有把上次展开的条数带回来。
  const first = await startInstanceIn({ root, baseUrl: mock.url })
  instance = first
  browser = await chromium.launch()
  const bootstrapContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const bootstrap = await bootstrapContext.newPage()
  watchProblems(bootstrap, problems)
  await bootstrap.goto(first.url, { waitUntil: 'domcontentloaded' })

  const workspaceRows = new Map(PROJECTS.map((project) => [project.id, workspaceRow(bootstrap, project.workspace)]))
  for (const project of PROJECTS) {
    await waitForLocator(workspaceRows.get(project.id), { description: `${project.workspace} 行`, timeoutMs: 20_000 })
  }
  await dismissWelcome(bootstrap)

  const known = new Set()
  const leaders = new Map()
  for (const [index, project] of PROJECTS.entries()) {
    const sessionId = await openSession(
      bootstrap,
      workspaceRows.get(project.id),
      known,
      `${project.name} 的 leader 会话`,
      index !== 0,
    )
    leaders.set(project.id, sessionId)
    known.add(sessionId)
    await say(bootstrap, project.leaderMarker, project.leaderReply, `${project.name} 的 leader`)
    const cwd = await waitFor({
      description: `${project.name} 的 leader 会话目录`,
      check: () => sessionCwd(first.home, sessionId),
      timeoutMs: 5_000,
    })
    assert.equal(
      realpathSync(cwd),
      realpathSync(dirs[project.id]),
      `${project.name} 的 leader 应落在对应工作区目录`,
    )
  }

  const workers = []
  for (const project of PROJECTS) {
    for (let index = 0; index < WORKERS_PER_PROJECT; index += 1) {
      const sessionId = await openSession(
        bootstrap,
        workspaceRows.get(project.id),
        known,
        `${project.name} 第 ${index + 1} 个 worker 会话`,
      )
      known.add(sessionId)
      await say(
        bootstrap,
        project.workerMarker(index),
        project.workerReply(index),
        `${project.name} 第 ${index + 1} 个 worker`,
      )
      workers.push({ projectId: project.id, id: sessionId, name: `${project.id}-worker-${index + 1}` })
    }
  }
  await bootstrapContext.close()
  await first.stop({ keepRoot: true })
  instance = null

  seedProjects(first.home, dirs, leaders, workers)

  // 第二段：A、B 各自展开到 6 条；收起 B 时 A 不能被拉回 5；再收起/重开 A、B
  // 都回到默认一页，且互不影响。
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

  const blocks = new Map(PROJECTS.map((project) => [project.id, projectBlock(page, project.name)]))
  const rows = new Map()
  const sessions = new Map()
  const overflows = new Map()
  for (const project of PROJECTS) {
    const block = blocks.get(project.id)
    rows.set(project.id, block.locator('.dsh-leader-agent-project-row').first())
    sessions.set(project.id, block.locator('.dsh-leader-agent-session-row'))
    overflows.set(project.id, block.locator('.dsh-leader-agent-session-overflow'))
    await waitForLocator(rows.get(project.id), { description: `${project.name} 的项目行`, timeoutMs: 20_000 })
  }
  const [projectA, projectB] = PROJECTS
  const rowA = rows.get(projectA.id)
  const rowB = rows.get(projectB.id)
  const sessionsA = sessions.get(projectA.id)
  const sessionsB = sessions.get(projectB.id)
  const overflowA = overflows.get(projectA.id)
  const overflowB = overflows.get(projectB.id)

  // 当前会话切到 A 的 leader，排除「当前会话参与水位」把某一页撑大。
  await rowA.click()
  await waitFor({
    description: '当前会话切到 A 的 leader',
    check: async () => (await rowA.getAttribute('data-selected')) === 'true',
  })

  await rowA.locator('button[aria-label="展开会话"]').click()
  await waitForLocator(sessionsA.first(), { description: 'A 展开后的第一条 worker 会话行' })
  await waitForCount(sessionsA, PAGE_SIZE, 'A 默认只露 5 条会话')
  assert.equal(await overflowA.innerText(), '展开其余 1 个会话', 'A 默认视图应只藏 1 条')

  await overflowA.click()
  await waitForCount(sessionsA, WORKERS_PER_PROJECT, 'A 展开其余后 6 条全可见')
  assert.equal(await overflowA.innerText(), '收起', 'A 全部放完后按钮应变成收起')

  await rowB.locator('button[aria-label="展开会话"]').click()
  await waitForLocator(sessionsB.first(), { description: 'B 展开后的第一条 worker 会话行' })
  await waitForCount(sessionsB, PAGE_SIZE, 'B 默认只露 5 条会话')
  assert.equal(await overflowB.innerText(), '展开其余 1 个会话', 'B 默认视图应只藏 1 条')

  await overflowB.click()
  await waitForCount(sessionsB, WORKERS_PER_PROJECT, 'B 展开其余后 6 条全可见')
  assert.equal(await overflowB.innerText(), '收起', 'B 全部放完后按钮应变成收起')
  await waitForCount(sessionsA, WORKERS_PER_PROJECT, 'B 展开后 A 仍是 6 条')

  // 切到 B 的 leader，再收起 B：B 的水位回到 0，A 的水位不能被跨项目共享。
  await rowB.click()
  await waitFor({
    description: '当前会话切到 B 的 leader',
    check: async () => (await rowB.getAttribute('data-selected')) === 'true',
  })
  await rowB.locator('button[aria-label="收起会话"]').click()
  await waitForCount(sessionsB, 0, '收起 B 后 B 的会话行全部消失')
  await waitForCount(sessionsA, WORKERS_PER_PROJECT, '收起 B 后 A 仍保持 6 条')
  assert.equal(await overflowA.innerText(), '收起', 'A 的水位不应被 B 的收起重置')

  await rowB.locator('button[aria-label="展开会话"]').click()
  await waitForLocator(sessionsB.first(), { description: 'B 重新展开后的第一条 worker 会话行' })
  await waitForCount(sessionsB, PAGE_SIZE, 'B 重新展开回到默认 5 条')
  assert.equal(await overflowB.innerText(), '展开其余 1 个会话', 'B 重新展开后剩余条数重新出现')
  await waitForCount(sessionsA, WORKERS_PER_PROJECT, 'B 重新展开后 A 仍保持 6 条')

  // 再收起 A：A 自己的水位清掉，B 的 5 条不受影响；重开 A 回到 5 条。
  await rowA.locator('button[aria-label="收起会话"]').click()
  await waitForCount(sessionsA, 0, '收起 A 后 A 的会话行全部消失')
  await waitForCount(sessionsB, PAGE_SIZE, '收起 A 后 B 仍保持 5 条')

  await rowA.locator('button[aria-label="展开会话"]').click()
  await waitForLocator(sessionsA.first(), { description: 'A 重新展开后的第一条 worker 会话行' })
  await waitForCount(sessionsA, PAGE_SIZE, 'A 重新展开回到默认 5 条')
  assert.equal(await overflowA.innerText(), '展开其余 1 个会话', 'A 重新展开后剩余条数重新出现')
  assert.equal(await sessionsB.count(), PAGE_SIZE, 'A 重新展开不应影响 B 的 5 条')

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
