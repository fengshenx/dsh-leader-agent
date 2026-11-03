/**
 * 项目树会话行的完成绿点：跑完没人看 → 亮，打开 → 灭。
 *
 * 两段式：第一段造一条跑完过一轮的 worker 会话（同 leader 目录、归属项目），
 * 第二段用它验证绿点的完整时序——重启后不凭空亮（进程内投影从头开始）、
 * running 中切走后完成跳变点亮、打开熄灭。断言落在插件自己的 DOM 上
 * （StateDot 的 data-state 属性），不读宿主内部状态。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { WORKTREE, startInstanceIn } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { waitFor, waitForLocator } from './harness.mjs'

/** 场景标记：一个标记只表达一个场景，两段各一轮。 */
const MARKER_FIRST = 'MOCK-E2E-DONE-DOT-FIRST'
const MARKER_SECOND = 'MOCK-E2E-DONE-DOT-SECOND'
const REPLY_SECOND = '第二轮回执'

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

/** 找正文里包含指定文本的会话（取它的 id 与 cwd）。 */
function sessionContaining(home, needle) {
  for (const text of readSessionLogs(home)) {
    if (!text.includes(needle)) continue
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

/** 把会话登记成项目：同目录的其余会话即项目树里的 worker 行。 */
function seedProject(home, leader) {
  mkdirSync(join(home, 'dsh-leader-kit'), { recursive: true })
  writeFileSync(join(home, 'dsh-leader-kit', 'projects.json'), `${JSON.stringify({
    version: 1,
    projects: [{
      id: 'e2e-done-dot-project',
      name: 'done-dot',
      directory: leader.cwd,
      leaderSessionId: leader.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

/**
 * 把会话登记成 worker：项目树的归属判据是「目录 + worker 登记表」，普通会话
 * 不进项目树，必须在启动前把登记表也种好。
 */
function seedWorkerRegistry(home, leader, worker) {
  mkdirSync(join(home, 'dsh-leader-kit'), { recursive: true })
  writeFileSync(join(home, 'dsh-leader-kit', 'workers.json'), `${JSON.stringify({
    version: 1,
    workers: [{
      childId: worker.id,
      parentSessionId: leader.id,
      name: 'done-dot-worker',
      registeredAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

/** 读页面上当前被选中的会话行 id（宿主行用 aria-selected 标当前）。 */
async function currentSessionId(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-row-key^="session:"][aria-selected="true"]')
    return row?.getAttribute('data-row-key')?.slice('session:'.length) ?? null
  })
}

/** 已知宿主竞态：视图快速切换时 `SidebarSessionView.dispose` 对已释放的 reference
 * 再操作（栈里没有插件帧，两篇 Agent Note 有记录）。本场景一个来回要切三次视图，
 * 命中率被放大到损害套件可用性，这里窄豁免这一条；其余 console.error 仍即失败。 */
const HOST_VIEW_DISPOSE_NOISE = /^Sidebar Session opening failed: Error: Session reference ".*" is released/

/**
 * 给页面挂错误收集：pageerror 全收，console.error 收集时豁免已知宿主噪音。
 *
 * @param {import('playwright').Page} page - 页面
 * @param {string[]} problems - 收集目标
 * @returns {void}
 */
function collectProblems(page, problems) {
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (HOST_VIEW_DISPOSE_NOISE.test(message.text())) return
    problems.push(`console.error: ${message.text()}`)
  })
}

test('worker 跑完且没人看亮绿点，打开后熄灭', { timeout: 180_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-kit-e2e-done-dot-'))
  const mock = await startMockProvider({
    // 第二轮要在「执行中」窗口里完成页面动作（等 running 圈、切到 leader、等
    // 选中态消失）——本地 mock 一轮只有几毫秒，动作插不进窗口。延迟不能太大：
    // 实测 3 秒会踩中宿主对 SSE 首事件的超时阈值，请求被 abort 重发、脚本耗尽
    // 变 400，轮次起不来（ongoing 都不出现）；1.5 秒在「够动作」与「不触超时」
    // 之间。
    stepDelayMs: 1500,
    scripts: {
      [MARKER_FIRST]: [{ text: '第一轮回执' }],
      [MARKER_SECOND]: [{ text: REPLY_SECOND }],
    },
  })
  const problems = []
  let browser = null
  let instance = null

  t.after(async () => {
    await browser?.close().catch(() => {})
    await instance?.stop().catch(() => {})
    await mock.stop().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  })

  // 第一段：建 worker 会话并让它跑完一轮——完成时它在主视图，本来就不该亮。
  const first = await startInstanceIn({ root, baseUrl: mock.url })
  browser = await chromium.launch()
  const bootstrapContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const bootstrapPage = await bootstrapContext.newPage()
  collectProblems(bootstrapPage, problems)
  await bootstrapPage.goto(first.url, { waitUntil: 'domcontentloaded' })
  const composer = bootstrapPage.locator('div[role="textbox"][contenteditable="true"]').first()
  await waitForLocator(composer, { description: '输入框', timeoutMs: 20_000 })

  const leader = firstSession(first.home)
  assert.notEqual(leader, null, '宿主启动后应有一个落盘的空会话')

  // 在工作区新建一条会话当 worker：新会话与 leader 同属实例目录，归属按目录判定。
  const workspaceRow = bootstrapPage.locator('[data-row-key^="workspace:"]').filter({ hasText: '默认工作区' }).first()
  await waitForLocator(workspaceRow, { description: '默认工作区行' })
  await workspaceRow.hover()
  await workspaceRow.locator('button[aria-label*="新建会话"]').first().click({ force: true })
  await waitFor({
    description: '新建会话成为当前会话',
    check: async () => (await currentSessionId(bootstrapPage)) !== null && (await currentSessionId(bootstrapPage)) !== leader.id,
  })

  await composer.click()
  await composer.fill(`${MARKER_FIRST} 收工即可`)
  await composer.press('Enter')
  await waitForLocator(bootstrapPage.getByText('第一轮回执').first(), { description: '第一轮回复上屏' })
  const workerId = await currentSessionId(bootstrapPage)
  assert.equal(typeof workerId, 'string', '应当能读到 worker 会话 id')
  await bootstrapContext.close()
  await first.stop({ keepRoot: true })

  const worker = sessionContaining(first.home, '第一轮回执')
  assert.notEqual(worker, null, 'worker 会话日志应已落盘')
  assert.equal(worker.id, workerId, '日志里的会话应与页面上选中的会话一致')
  assert.equal(worker.cwd, leader.cwd, '工作区新建会话应与 leader 同目录，否则不归属项目')
  seedProject(first.home, leader)
  seedWorkerRegistry(first.home, leader, worker)

  // 第二段：重启后投影从头开始——跑完过一轮的 worker 不凭空亮绿点。
  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  collectProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })

  const projectRow = page.locator('.dsh-leader-kit-project-row').first()
  await waitForLocator(projectRow, { description: '项目行', timeoutMs: 20_000 })
  await projectRow.locator('button[aria-label="展开会话"]').click()
  const workerRow = page.locator(`.dsh-leader-kit-session-row[data-session-id="${worker.id}"]`)
  await waitForLocator(workerRow, { description: '项目树里的 worker 会话行' })
  assert.equal(
    await workerRow.locator('[data-state]').count(),
    0,
    '重启后挂载前已空闲的会话不该亮任何状态点',
  )

  // 打开 worker 跑第二轮；等 running 圈出现再切走——切走先于完成跳变，
  // 完成时 worker 不在主视图，绿点必须点亮。
  await workerRow.click()
  const secondComposer = page.locator('div[role="textbox"][contenteditable="true"]').first()
  await waitForLocator(secondComposer, { description: 'worker 会话的输入框' })
  await secondComposer.click()
  await secondComposer.fill(`${MARKER_SECOND} 收工即可`)
  await secondComposer.press('Enter')
  await waitForLocator(workerRow.locator('[data-state="ongoing"]'), { description: 'worker 行的运行中加载圈' })

  await projectRow.click()
  await waitForLocator(page.locator('.dsh-leader-kit-guide-card'), { description: 'leader 欢迎卡（切走完成）' })
  // leader 的欢迎卡出现不等于 worker 已退出主视图：宿主的视图释放链是异步的，
  // worker 的 mainView retain 没清零前完成跳变会被当作「有人看着」而不点亮。
  // 行失去选中态（选中态与投影读的是同一份 retainedBy 快照）才是切走完成的确证。
  await waitFor({
    description: 'worker 会话行退出选中态（主视图 retain 已释放）',
    check: async () => (await workerRow.getAttribute('data-selected')) !== 'true',
  })
  try {
    await waitForLocator(workerRow.locator('[data-state="done"]'), { description: '完成跳变点亮的绿点' })
  } catch (error) {
    // 页面读数 waitForLocator 已带；这里补它拿不到的两样——mock 收到的 scenario
    // 请求数（>2 说明宿主重发了请求、脚本耗尽变 400，轮次起不来）与实例日志尾。
    const scenarioRequests = mock.requests.filter((request) => request.kind === 'scenario')
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}；scenario 请求数：${scenarioRequests.length}；`
      + `实例日志尾：${instance.logs.join('').slice(-1500)}`,
      { cause: error },
    )
  }

  // 取证帧取点亮时刻：最终帧绿点已熄灭，看不出效果。
  const artifacts = join(WORKTREE, '.dev', 'e2e-artifacts', `session-done-dot-${process.pid}`)
  mkdirSync(artifacts, { recursive: true })
  await page.screenshot({ path: join(artifacts, 'done-dot-lit.png') })
  console.log(`[e2e] 截图 ${join(artifacts, 'done-dot-lit.png')}`)

  // 打开 worker：绿点熄灭。点亮期间行 title 带「已完成，待查看」的悬停说明。
  const titleWithDot = await workerRow.getAttribute('title')
  assert.match(titleWithDot ?? '', /已完成，待查看$/, '绿点亮着时行 title 应说明完成待查看')
  await workerRow.click()
  await waitForLocator(workerRow.locator('[data-state="done"]'), { description: '绿点随打开熄灭', state: 'detached' })
  assert.doesNotMatch(
    await workerRow.getAttribute('title') ?? '',
    /已完成，待查看/,
    '打开后 title 不该再带完成说明',
  )

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
