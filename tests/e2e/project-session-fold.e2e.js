/**
 * 项目树会话列表的水位与排序：默认露 5 条，展开其余后收起项目、再展开回到 5 条；
 * worker 之间按登记表 `lastUsedAt` 倒序（与创建顺序区分）。
 *
 * 两个项目各自有一份水位：展开 A 到 6 条、收起 B 时 A 不受影响，B 回到 5；
 * 再收起 A 后重开也回到 5。两段起实例（同 `projects.json` / `workers.json` 的
 * 惯例）：第一段在两个工作区里各建一个 leader 与 6 个 worker，停掉后登记进两个
 * 项目；第二段验证隔离与回落，并把 A 的一条 worker 跑成完成未读，验证它不会把
 * 列表撑开。断言只落在插件自己的 DOM（会话行数与「展开其余」按钮文案）上。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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

const WORKSPACE_FIXTURE_HINT = '宿主未接受 workspace fixture（workspace 域格式可能已升级）'

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
 * 仅测试夹具：生产代码不读写 `home/storages/workspace.json`。工作区选择器走
 * 系统目录选择，无头 Chromium 驱动不了；这里直接写宿主 workspace 域的落盘格式
 * （version 2），写完立即回读校验，宿主升级该域时要在显式断言上失败。
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
  const storagePath = join(root, 'home', 'storages', 'workspace.json')
  writeFileSync(storagePath, `${JSON.stringify({
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

  const stored = JSON.parse(readFileSync(storagePath, 'utf8'))
  assert.equal(
    stored.unit?.version,
    2,
    'workspace fixture 的域版本应为 2——宿主升级 workspace 域时这里要同步',
  )
  assert.deepEqual(stored.global?.workspaceIds, WORKSPACE_IDS, 'workspace fixture 应登记两个工作区')
  PROJECTS.forEach((project, index) => {
    const record = stored.tables?.workspaces?.[WORKSPACE_IDS[index]]
    assert.ok(record, `workspace fixture 缺少 ${project.workspace} 的记录`)
    assert.equal(
      record.path,
      realpathSync(dirs[project.id]),
      `${project.workspace} 的路径应写入 fixture`,
    )
  })
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
  const byProject = new Map()
  for (const worker of workers) {
    const list = byProject.get(worker.projectId) ?? []
    list.push(worker)
    byProject.set(worker.projectId, list)
  }
  writeFileSync(join(home, 'dsh-leader-agent', 'workers.json'), `${JSON.stringify({
    version: 1,
    workers: workers.map((worker) => {
      const list = byProject.get(worker.projectId)
      const index = list.indexOf(worker)
      return {
        childId: worker.id,
        parentSessionId: leaders.get(worker.projectId),
        name: worker.name,
        registeredAt: now,
        // 与创建顺序相反：每个项目第 1 个 worker 最后使用时间最新，用来验证 DOM 顺序。
        lastUsedAt: now - index * 1000,
      }
    }),
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
  let completionMock = null

  t.after(async () => {
    try {
      await stopScenario({ browser, instance, mock, root })
    } finally {
      await completionMock?.stop()
    }
  })

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
    await waitForLocator(workspaceRows.get(project.id), { description: `${WORKSPACE_FIXTURE_HINT}：等待 ${project.workspace} 行`, timeoutMs: 20_000 })
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

  // 第二段单独起一个带延迟的 mock：完成未读要在「运行中」窗口里切走才会点亮。
  // 标记沿用第一轮，请求历史里仍只有一个标记；每个标记只补一步新回执。
  const completionScripts = {}
  for (let index = 0; index < WORKERS_PER_PROJECT; index += 1) {
    completionScripts[PROJECTS[0].workerMarker(index)] = [{ text: `折叠场景：A worker ${index + 1} 第二轮回执。` }]
  }
  completionMock = await startMockProvider({ scripts: completionScripts, stepDelayMs: 1200 })

  // 第二段：A、B 各自展开到 6 条；收起 B 时 A 不能被拉回 5；再收起/重开 A、B
  // 都回到默认一页，且互不影响。
  const second = await startInstanceIn({ root, baseUrl: completionMock.url })
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
  // 原 worker-session-order 的 DOM 顺序守卫：创建顺序是 A1..A6，登记表 lastUsedAt
  // 反过来，排序正确时页面应显示 A1..A6（而不是会话库默认的 A6..A1）。
  const orderedA = await sessionsA.evaluateAll((nodes) => nodes.map((node) => node.dataset.sessionId))
  const expectedA = workers.filter((worker) => worker.projectId === projectA.id).map((worker) => worker.id)
  assert.deepEqual(
    orderedA,
    expectedA,
    `排序：A 的 ${WORKERS_PER_PROJECT} 条 worker 应按最近使用倒序；期望 ${expectedA.join(', ')}，实际 ${orderedA.join(', ')}`,
  )

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

  // 完成未读不撑开列表：把 A 最老的一条 worker 跑成完成未读，再让其余 5 条各
  // 跑一轮压到它前面，使它落在第 6 条。旧实现会因 completed 把基线抬到 6，
  // 新实现重开项目仍只露 5 条，目标行折在「展开其余」后面。
  const workersA = workers.filter((worker) => worker.projectId === projectA.id)
  assert.equal(workersA.length, WORKERS_PER_PROJECT, 'A 应有 6 条 worker 会话')
  const completedWorker = workersA[0]
  const completedRow = page.locator(`.dsh-leader-agent-session-row[data-session-id="${completedWorker.id}"]`)
  await overflowA.click()
  await waitForCount(sessionsA, WORKERS_PER_PROJECT, 'A 先展开到全部 6 条')
  await completedRow.click()
  const completionComposer = page.locator('div[role="textbox"][contenteditable="true"]').first()
  await waitForLocator(completionComposer, { description: '完成未读 worker 的输入框' })
  await completionComposer.click()
  await completionComposer.fill(PROJECTS[0].workerMarker(0))
  await completionComposer.press('Enter')
  await waitForLocator(completedRow.locator('[data-state="ongoing"]'), { description: '完成未读 worker 的运行中加载圈' })
  await rowA.click()
  await waitFor({
    description: '切回 A 的 leader',
    check: async () => (await rowA.getAttribute('data-selected')) === 'true',
  })
  await waitFor({
    description: '完成未读 worker 退出主视图',
    check: async () => (await completedRow.getAttribute('data-selected')) !== 'true',
  })
  await waitForLocator(completedRow.locator('[data-state="done"]'), { description: '完成未读 worker 的绿点' })

  for (let index = 1; index < WORKERS_PER_PROJECT; index += 1) {
    const workerRow = page.locator(`.dsh-leader-agent-session-row[data-session-id="${workersA[index].id}"]`)
    await workerRow.click()
    await say(
      page,
      PROJECTS[0].workerMarker(index),
      `折叠场景：A worker ${index + 1} 第二轮回执。`,
      `A 第 ${index + 1} 个 worker 压序`,
    )
    await rowA.click()
    await waitFor({
      description: `A 第 ${index + 1} 个 worker 压序后切回 leader`,
      check: async () => (await rowA.getAttribute('data-selected')) === 'true',
    })
  }

  // 目标完成行现在是第 6 条；旧实现会把它抬进基线，新实现仍只露 5 条。
  await rowA.locator('button[aria-label="收起会话"]').click()
  await waitForCount(sessionsA, 0, '压序后收起 A')
  await rowA.locator('button[aria-label="展开会话"]').click()
  await waitForCount(sessionsA, PAGE_SIZE, 'A 重新展开仍只露 5 条（完成未读不撑开）')
  assert.equal(await overflowA.innerText(), '展开其余 1 个会话', '完成未读 worker 应被折进展开其余')

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
