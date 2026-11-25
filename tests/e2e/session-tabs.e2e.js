/**
 * 项目会话标签栏：leader 标签、worker 标签、关闭/重开与普通会话隐藏。
 *
 * 场景两段起实例（同 `projects.json` / `workers.json` 的惯例）：第一段让宿主自己
 * 建出 leader 与两个 worker 会话并各跑一轮 mock，停掉后把会话登记进项目；第二段
 * 从项目行打开 leader，验证标签栏与真实会话切换。
 *
 * 断言只落在插件自己的 DOM（标签的 data-session-id / aria-selected / 状态灯）
 * 与交互后的状态上；栏高、控件坐标、滚动溢出这类样式与布局不写进 e2e（300px
 * 窄窗里「更多」菜单的开/关是交互行为，保留）。
 * 不读宿主内部状态，也不把「当前会话」委托给宿主会话行——
 * 项目会话恰好被左栏排除，宿主树里没有它们的行。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { WORKTREE, startInstanceIn } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { LOCALE_UI } from '../../src/client/locales.js'
import { scenarioTimeout, stopScenario, waitFor, waitForLocator, watchProblems } from './harness.mjs'

const M = {
  leader: 'MOCK-TABS-LEADER',
  w1: 'MOCK-TABS-W1',
  w2: 'MOCK-TABS-W2',
}

const LEADER_REPLY = '标签场景：leader 已接活，拆给两个 worker。'

const WORKERS = [
  { key: 'w1', name: '前端 · 卡片重构', reply: '前端：卡片容器和动效已经改完。' },
  { key: 'w2', name: '后端 · 接口联调', reply: '后端：接口字段对齐，联调通过。' },
]

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

/** 记录切换期间看板骨架有没有被重新挂载（保留 body 的回归点）。 */
async function watchBoardSkeleton(page) {
  await page.evaluate(() => {
    window.__boardSkeletonSeen = false
    window.__boardSkeletonObserver?.disconnect()
    window.__boardSkeletonObserver = new MutationObserver(() => {
      if (document.querySelector('.dsh-leader-agent-board-skeleton')) window.__boardSkeletonSeen = true
    })
    window.__boardSkeletonObserver.observe(document.body, { childList: true, subtree: true })
  })
}

/** 读切换期间是否出现过看板骨架。 */
async function boardSkeletonSeen(page) {
  return page.evaluate(() => window.__boardSkeletonSeen === true)
}

/** 首次打开宿主会弹「预览版说明」，不关掉会挡住输入框。 */
async function dismissWelcome(page) {
  const button = page.getByRole('dialog').getByRole('button', { name: '继续' })
  try { await button.click({ timeout: 4000 }) } catch { /* 没弹窗就继续 */ }
}

/** 读页面上当前被选中的宿主会话 id。 */
async function currentSessionId(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-row-key^="session:"][aria-selected="true"]')
    return row?.getAttribute('data-row-key')?.slice('session:'.length) ?? null
  })
}

/** 写项目与 worker 登记表。 */
function seed(home, leader, workers) {
  mkdirSync(join(home, 'dsh-leader-agent'), { recursive: true })
  const now = Date.now()
  writeFileSync(join(home, 'dsh-leader-agent', 'projects.json'), `${JSON.stringify({
    version: 1,
    projects: [{
      id: 'session-tabs-project',
      name: '网站改版',
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

/** 运行中往数据根塞一张卡：看板每 2 秒轮询，下一轮就能看到。 */
function seedCard(home) {
  const now = Date.now()
  writeFileSync(join(home, 'dsh-leader-agent', 'cards.json'), `${JSON.stringify({
    version: 1,
    counter: 1,
    cards: [{
      id: 'session-tabs-card-1',
      number: 1,
      revision: 1,
      title: '标签场景卡',
      spec: '用于验证切会话时详情浮层不留在新会话上。',
      status: 'active',
      projectId: 'session-tabs-project',
      slots: {},
      createdAt: now - 1000,
      updatedAt: now - 1000,
    }],
  }, null, 2)}\n`)
}

/** 当前获得焦点的标签（按 data-session-id 读）。 */
async function focusedTabId(page) {
  return page.evaluate(() => document.activeElement?.closest?.('[data-session-id]')?.getAttribute('data-session-id') ?? null)
}

/** 收起右栏：只认当前会话头/可见座位上的控件，被保留的旧座位不算。 */
async function collapseRightbar(page) {
  const toggle = page.locator('[data-sidebar-right-toggle]:visible').first()
  const expand = page.locator('[data-sidebar-right-expand]:visible').first()
  await waitFor({
    description: '右栏状态落定',
    check: async () => (await toggle.count()) > 0 || (await expand.count()) > 0,
    timeoutMs: 10_000,
  })
  if (await toggle.count() > 0) await toggle.click({ force: true })
  await waitFor({
    description: '右栏收起后展开按钮可用',
    check: async () => (await expand.count()) > 0 && !(await expand.isDisabled()),
    timeoutMs: 10_000,
  })
}

/** 展开项目树；项目行已展开时没有切换按钮。 */
async function expandProject(page) {
  const projectRow = page.locator('.dsh-leader-agent-project-row').first()
  await waitForLocator(projectRow, { description: '项目行出现', timeoutMs: 20_000 })
  const toggle = projectRow.locator('button[aria-label="展开会话"]')
  if (await toggle.count() > 0) await toggle.click()
  await waitForLocator(page.locator('.dsh-leader-agent-session-row').first(), {
    description: '项目树里的 worker 会话行出现',
    timeoutMs: 15_000,
  })
  return projectRow
}

test('项目会话标签栏：leader 标签与 worker 标签可切换、可关闭重开，普通会话隐藏', {
  timeout: scenarioTimeout(150_000),
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-session-tabs-'))
  const problems = []
  const scripts = {
    [M.leader]: [{ text: LEADER_REPLY }],
    [M.w1]: [{ text: WORKERS[0].reply }],
    [M.w2]: [{ text: WORKERS[1].reply }],
  }
  const mock = await startMockProvider({ scripts })
  let browser = null
  let instance = null

  t.after(() => stopScenario({ browser, instance, mock, root }))

  // 第一段：建 leader + 两个 worker 会话。
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
  await composer.fill(`${M.leader} 把卡片区的交互重构拆给前端和后端。`)
  await composer.press('Enter')
  await waitForLocator(bootstrap.getByText(LEADER_REPLY).first(), { description: 'leader 回复上屏' })

  const workspaceRow = bootstrap.locator('[data-row-key^="workspace:"]').filter({ hasText: '默认工作区' }).first()
  await waitForLocator(workspaceRow, { description: '默认工作区行', timeoutMs: 20_000 })
  const workers = []
  for (const worker of WORKERS) {
    await workspaceRow.hover()
    await workspaceRow.locator('button[aria-label*="新建会话"]').first().click({ force: true })
    const id = await waitFor({
      description: `新建 ${worker.name} 的会话`,
      check: async () => {
        const current = await currentSessionId(bootstrap)
        return typeof current === 'string' && current !== leader.id && !workers.some((item) => item.id === current)
          ? current
          : null
      },
      timeoutMs: 15_000,
    })
    await composer.click()
    await composer.fill(`${M[worker.key]} 开始吧`)
    await composer.press('Enter')
    await waitForLocator(bootstrap.getByText(worker.reply).first(), { description: `${worker.name} 回复上屏` })
    workers.push({ ...worker, id })
  }
  await bootstrapContext.close()
  await first.stop({ keepRoot: true })
  instance = null

  seed(first.home, leader, workers)

  // 第二段：从项目行打开 leader，验证标签栏。
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

  const projectRow = await expandProject(page)
  await projectRow.click()

  const bar = page.locator('.dsh-leader-agent-tabs')
  await waitForLocator(bar, { description: 'leader 会话显示项目标签栏', timeoutMs: 20_000 })
  const leaderTab = bar.locator('.dsh-leader-agent-tab[data-kind="leader"]')
  await waitForLocator(leaderTab, { description: '项目标签（leader 入口）', timeoutMs: 10_000 })
  assert.equal((await leaderTab.innerText()).trim(), '网站改版', '项目标签应当是项目名，不再单列 Leader')
  assert.equal(await bar.locator('.dsh-leader-agent-tab[data-kind="worker"]').count(), 0, '没点开的 worker 不该先出标签')
  // 栏可见时才给主列加 flex 收缩标记；这是 DOM 属性，不是样式值。
  assert.equal(await page.locator('[data-dsh-leader-agent-tabs-column]').count(), 1, '栏可见时应给主列加 flex 收缩标记')
  assert.equal(await page.locator('[data-dsh-leader-agent-tabs-main]').count(), 1, '栏可见时应给会话体加主列标记')

  const artifacts = join(WORKTREE, '.dev', 'e2e-artifacts', 'session-tabs')
  mkdirSync(artifacts, { recursive: true })
  await page.screenshot({ path: join(artifacts, 'leader-bar.png') })

  const moreButton = page.locator('[data-dsh-leader-agent-tabs-more]')
  const contextMenu = page.locator('[data-context-menu]')
  await moreButton.click()
  await waitForLocator(contextMenu, { description: '标签栏的会话更多菜单', timeoutMs: 10_000 })
  assert.equal(await moreButton.getAttribute('aria-expanded'), 'true', '菜单打开时按钮 aria-expanded 应为 true')
  await page.keyboard.press('Escape')
  await waitFor({
    description: '更多菜单关闭',
    check: async () => (await moreButton.getAttribute('aria-expanded')) === 'false',
    timeoutMs: 10_000,
  })

  // 点外部关闭：不能只靠 Escape；菜单必须真的 detached，aria-expanded 跟回来。
  await moreButton.click()
  await waitForLocator(contextMenu, { description: '再次打开更多菜单', timeoutMs: 10_000 })
  await page.mouse.click(720, 180)
  await waitFor({
    description: '点外部后更多菜单关闭',
    check: async () => (await contextMenu.count()) === 0
      && (await moreButton.getAttribute('aria-expanded')) === 'false',
    timeoutMs: 10_000,
  })

  // 右栏开关与会话「更多」都挂标签栏；原会话头菜单按钮让位，避免同一个菜单
  // 出现两次。控件坐标与同排对齐属于样式，不写进 e2e。
  const expandControl = page.locator('[data-sidebar-right-expand]:visible').first()
  const headerMenuButtons = page.locator('[class*="headerMenuButton"]')
  assert.equal(await headerMenuButtons.count(), 1, '会话头标题行原更多按钮应仍挂载，才能证明是隐藏而不是不存在')
  assert.equal(
    await page.locator('[class*="headerMenuButton"]:visible').count(),
    0,
    '会话头标题行里的更多按钮应让位给标签栏，避免同一个菜单出现两次',
  )

  // 右栏打开 leader 看板，再切 worker：右栏按会话隔离，看板要在 worker 的右栏里
  // 继续显示（看板是项目级的，worker 也看同一块），而不是切成 worker 的默认 guide。
  await expandControl.click({ force: true })
  await waitFor({
    description: '右栏绑定到 leader 会话',
    check: async () => (await page.locator('[data-sidebar-right-session]').first().getAttribute('data-sidebar-right-session')) === leader.id,
    timeoutMs: 15_000,
  })
  const boardEntry = page.locator('.dsh-leader-agent-guide-entry[data-sidebar-right-guide-entry="dsh-leader-agent-board"]')
  await waitForLocator(boardEntry, { description: '右栏 guide 页的看板入口', timeoutMs: 15_000 })
  await boardEntry.click()
  const leaderBoard = page.locator(`[data-sidebar-right-session="${leader.id}"] .dsh-leader-agent-board-empty`)
    .filter({ hasText: '还没有卡片' })
  await waitForLocator(leaderBoard, { description: 'leader 右栏的看板空态', timeoutMs: 15_000 })
  await page.screenshot({ path: join(artifacts, 'leader-board.png') })

  // 右栏展开后宿主的收起按钮可见；开关收起/展开是否同坐标属于样式，不写进 e2e。
  const collapseButton = page.locator('[data-sidebar-right-toggle]:visible').first()
  await waitForLocator(collapseButton, { description: '右栏展开后宿主的收起按钮', timeoutMs: 10_000 })

  // 点项目树里的 worker：形成标签并成为当前标签。
  const w1 = workers[0]
  const workerBoard = page.locator(`[data-sidebar-right-session="${w1.id}"] .dsh-leader-agent-board-empty`)
    .filter({ hasText: '还没有卡片' })
  const w1Row = page.locator(`.dsh-leader-agent-session-row[data-session-id="${w1.id}"]`)
  await waitForLocator(w1Row, { description: '第一个 worker 的会话行', timeoutMs: 10_000 })
  const rowTitle = (await w1Row.locator('.dsh-leader-agent-session-title').innerText()).trim()
  await watchBoardSkeleton(page)
  await w1Row.click()
  const w1Tab = bar.locator(`.dsh-leader-agent-tab[data-session-id="${w1.id}"]`)
  await waitForLocator(w1Tab, { description: '点开 worker 后出现标签', timeoutMs: 10_000 })
  await waitFor({
    description: 'worker 标签成为当前标签',
    check: async () => (await w1Tab.getAttribute('aria-selected')) === 'true',
  })
  assert.equal(await bar.locator('.dsh-leader-agent-tab').count(), 2, '当前项目应有两个标签：leader + 这个 worker')
  await waitForLocator(workerBoard, { description: '切到 worker 后右栏仍是 leader 那块看板', timeoutMs: 15_000 })
  assert.equal(await boardSkeletonSeen(page), false, '第一次切 worker 也不应闪看板骨架')
  await page.screenshot({ path: join(artifacts, 'worker-board.png') })
  const tabLabel = (await w1Tab.locator('.dsh-leader-agent-tab-label').innerText()).trim()
  assert.ok(tabLabel.length > 0, 'worker 标签不能是空文字')
  assert.ok(rowTitle.startsWith(tabLabel) || tabLabel.startsWith(rowTitle), `标签文字应跟着会话标题：tab=${tabLabel} row=${rowTitle}`)
  const dot = w1Tab.locator('.dsh-leader-agent-tab-dot [data-signal]')
  assert.equal(await dot.count(), 1, 'worker 标签应有一个信号灯')
  const signal = await dot.getAttribute('data-signal')
  assert.ok(['running', 'unread', 'idle'].includes(signal), `信号灯档位应是运行中/完成未读/空闲，实际 ${signal}`)
  assert.ok((await dot.getAttribute('class')).includes(`dsh-leader-agent-tab-signal-${signal}`), '信号灯 class 要带上档位')
  // class 与语义分开写，两者同时写错时只查 class 仍会绿；aria-label 钉住「档位 → 文案」这条映射
  const uiLang = (await page.evaluate(() => document.documentElement.lang)).split('-')[0]
  const dict = LOCALE_UI[uiLang] ?? LOCALE_UI.en
  assert.equal(await dot.getAttribute('role'), 'img', '信号灯用 img 角色承载状态语义')
  assert.equal(await dot.getAttribute('aria-label'), dict[`board.state.${signal}`], `档位 ${signal} 的 aria-label 要取 board.state.*`)
  assert.equal(await w1Tab.locator('.dsh-leader-agent-tab-dot [data-state]').count(), 0, '标签不应再用宿主 StateDot 的转圈 spinner')
  await page.screenshot({ path: join(artifacts, 'worker-tab.png') })

  // 点项目标签回到 leader：保留的看板 body 不应重挂骨架。
  await watchBoardSkeleton(page)
  await leaderTab.click()
  await waitFor({
    description: '项目标签重新成为当前标签',
    check: async () => (await leaderTab.getAttribute('aria-selected')) === 'true',
  })
  await waitForLocator(leaderBoard, { description: '回到 leader 后看板仍在', timeoutMs: 10_000 })
  assert.equal(await boardSkeletonSeen(page), false, '切回 leader 不应重挂看板骨架')
  assert.equal(await w1Tab.getAttribute('aria-selected'), 'false', '回到 leader 后 worker 标签不再选中')

  // 关 worker 标签：标签消失、会话行还在、当前回到 leader。
  await w1Tab.hover()
  await w1Tab.locator('.dsh-leader-agent-tab-close').click()
  await waitForLocator(w1Tab, { description: '关掉的 worker 标签消失', state: 'detached', timeoutMs: 10_000 })
  await waitFor({
    description: '关掉当前标签后回到项目标签',
    check: async () => (await leaderTab.getAttribute('aria-selected')) === 'true',
  })
  assert.equal(await page.locator('.dsh-leader-agent-session-row').count(), 2, '关标签不能动会话行')

  // 从项目树重新点开：标签记回来；worker 的看板也应从保留的 body 直接显示。
  await watchBoardSkeleton(page)
  await w1Row.click()
  await waitForLocator(w1Tab, { description: '重新点开 worker 后标签回来', timeoutMs: 10_000 })
  await waitFor({
    description: '重开的 worker 标签成为当前标签',
    check: async () => (await w1Tab.getAttribute('aria-selected')) === 'true',
  })
  await waitForLocator(workerBoard, { description: '重开 worker 后看板仍在', timeoutMs: 10_000 })
  assert.equal(await boardSkeletonSeen(page), false, '重开 worker 不应重挂看板骨架')

  // 键盘：非当前标签 tabIndex=-1，方向键与 Home/End 是唯一入口。
  await w1Tab.focus()
  await page.keyboard.press('ArrowLeft')
  await waitFor({
    description: '← 切回项目标签',
    check: async () => (await leaderTab.getAttribute('aria-selected')) === 'true',
  })
  assert.equal(await focusedTabId(page), leader.id, '键盘切换后焦点应落在新标签上')
  await page.keyboard.press('End')
  await waitFor({
    description: 'End 切到最后一个标签',
    check: async () => (await w1Tab.getAttribute('aria-selected')) === 'true',
  })
  await page.keyboard.press('Home')
  await waitFor({
    description: 'Home 切回第一个标签',
    check: async () => (await leaderTab.getAttribute('aria-selected')) === 'true',
  })
  await page.screenshot({ path: join(artifacts, 'tabs-keyboard.png') })

  // 右栏收起时切 worker：不顶开右栏（看板只在展开且在前台时跟随）。
  // 用没被跟随过的 w2：先把 leader 的右栏收起，再第一次点开 w2。
  const w2 = workers[1]
  const w2Row = page.locator(`.dsh-leader-agent-session-row[data-session-id="${w2.id}"]`)
  const w2Tab = bar.locator(`.dsh-leader-agent-tab[data-session-id="${w2.id}"]`)
  await waitForLocator(w2Row, { description: '第二个 worker 的会话行', timeoutMs: 10_000 })
  await collapseRightbar(page)
  await w2Row.click()
  await waitForLocator(w2Tab, { description: '第一次点开 w2 后出现标签', timeoutMs: 10_000 })
  await waitFor({
    description: '收起状态下切到 w2',
    check: async () => (await w2Tab.getAttribute('aria-selected')) === 'true',
  })
  const expandButton = page.locator('[data-sidebar-right-expand]:visible').first()
  assert.equal(await expandButton.count(), 1, '右栏收起时切 worker 不应被强行展开')
  assert.equal(await expandButton.isDisabled(), false, '收起状态下展开按钮应可用')
  assert.equal(
    await page.locator(`[data-sidebar-right-session="${w2.id}"] .dsh-leader-agent-board`).isVisible().catch(() => false),
    false,
    '右栏收起时不应把看板打开（看板只在展开且在前台时跟随）',
  )
  await page.screenshot({ path: join(artifacts, 'tabs-collapsed-follow.png') })

  // 展开 w2 的右栏并打开看板：它没有被跟随过，所以从 guide 入口进。
  await expandButton.click({ force: true })
  await waitFor({
    description: '展开后右栏绑到 w2',
    check: async () => (await page.locator('[data-sidebar-right-session]:visible').first().getAttribute('data-sidebar-right-session').catch(() => null)) === w2.id,
    timeoutMs: 15_000,
  })
  const boardEntry2 = page.locator('.dsh-leader-agent-guide-entry[data-sidebar-right-guide-entry="dsh-leader-agent-board"]')
  await waitForLocator(boardEntry2, { description: 'w2 右栏 guide 页的看板入口', timeoutMs: 15_000 })
  await boardEntry2.click()
  seedCard(second.home)
  const card = page.locator('.dsh-leader-agent-board-card').filter({ hasText: '标签场景卡' })
  await waitForLocator(card, { description: '轮询拉到新种的卡', timeoutMs: 15_000 })

  // 详情浮层 portal 到 body。真实交互摸不到它背面的标签/项目树（遮罩挡住指针），
  // 宿主的全局快捷键又按 `aria-modal` 把命令挡在 `other` modal 上——所以这条泄漏
  // 目前不是可交互触发；用程序化 click 走同一个「切会话」状态路径，锁住隐藏时
  // 卸载浮层的行为（见 docs/limitations.md 的暂停范围）。
  await card.click()
  const detail = page.locator('.dsh-leader-agent-card-detail')
  await waitForLocator(detail, { description: '卡片详情浮层打开', timeoutMs: 10_000 })
  await page.evaluate((sessionId) => {
    document.querySelector(`.dsh-leader-agent-session-row[data-session-id="${sessionId}"]`)?.click()
  }, w1.id)
  await waitFor({
    description: '程序化切回 w1',
    check: async () => (await currentSessionId(page)) === w1.id,
    timeoutMs: 20_000,
  })
  await waitForLocator(detail, { description: '切走后详情浮层关闭', state: 'detached', timeoutMs: 10_000 })
  assert.equal(await page.locator('.dsh-leader-agent-modal-root').count(), 0, '旧项目的浮层不能留在新会话上')
  await page.screenshot({ path: join(artifacts, 'overlay-closed-on-switch.png') })

  // B1：程序化切会话绕过标签点击的 pointerdown；旧 sessionHeader 菜单必须收起。
  await moreButton.click()
  await waitForLocator(contextMenu, { description: 'B1 打开更多菜单', timeoutMs: 10_000 })
  await page.evaluate(() => {
    document.querySelector('.dsh-leader-agent-tab[data-kind="leader"]')?.click()
  })
  await waitFor({
    description: 'B1 程序化切回 leader',
    check: async () => (await currentSessionId(page)) === leader.id,
    timeoutMs: 20_000,
  })
  await waitFor({
    description: 'B1 切会话后菜单 detached 且 aria-expanded=false',
    check: async () => (await contextMenu.count()) === 0
      && (await moreButton.getAttribute('aria-expanded')) === 'false',
    timeoutMs: 10_000,
  })
  t.diagnostic(`REVIEW_SWITCH ${JSON.stringify({
    expanded: await moreButton.getAttribute('aria-expanded'),
    menuCount: await contextMenu.count(),
  })}`)

  // 极窄窗且两个标签：标签滚动区溢出时「更多」仍可点、菜单能开能关。这是交互
  // 行为，不是样式读数；滚动宽度与几何值交给人工取证。
  await page.setViewportSize({ width: 300, height: 900 })
  await moreButton.click()
  await waitForLocator(contextMenu, { description: '300px 窄窗打开更多菜单', timeoutMs: 10_000 })
  await page.keyboard.press('Escape')
  await waitFor({
    description: '300px 窄窗 Escape 关闭更多菜单',
    check: async () => (await contextMenu.count()) === 0
      && (await moreButton.getAttribute('aria-expanded')) === 'false',
    timeoutMs: 10_000,
  })
  t.diagnostic('NARROW_300 menu=open-close')
  await page.setViewportSize({ width: 1440, height: 900 })

  // 普通会话：同一工作区里新建，不属于项目，整条栏消失。
  const ordinaryWorkspaceRow = page.locator('[data-row-key^="workspace:"]').filter({ hasText: '默认工作区' }).first()
  await waitForLocator(ordinaryWorkspaceRow, { description: '第二段默认工作区行', timeoutMs: 20_000 })
  await ordinaryWorkspaceRow.hover()
  await ordinaryWorkspaceRow.locator('button[aria-label*="新建会话"]').first().click({ force: true })
  await waitFor({
    description: '普通会话成为当前会话',
    check: async () => {
      const now = await currentSessionId(page)
      return typeof now === 'string' && now !== leader.id && now !== w1.id && now !== w2.id
    },
    timeoutMs: 20_000,
  })
  await waitForLocator(bar, { description: '普通会话不显示标签栏', state: 'detached', timeoutMs: 15_000 })
  assert.equal(await page.locator('.dsh-leader-agent-tabs').count(), 0, '普通会话整条栏都不在')
  assert.equal(await page.locator('[data-dsh-leader-agent-tabs-column]').count(), 0, '栏隐藏后不能常驻覆盖宿主布局')
  assert.equal(await page.locator('[data-dsh-leader-agent-tabs-main]').count(), 0, '栏隐藏后会话体的 flex 标记也要摘掉')
  await page.screenshot({ path: join(artifacts, 'ordinary-session.png') })

  assert.deepEqual(problems, [])
})
