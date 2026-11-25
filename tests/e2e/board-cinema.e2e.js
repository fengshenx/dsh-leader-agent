/**
 * 看板两种模式：默认工作列表，设置页切到炫酷后 rail 的行/槽位由卡片数据驱动。
 *
 * 线路图的几何由渲染后实测决定，单测只能钉住路径规划，钉不住「DOM 里真的画了
 * 几条线、几个执行者节点」。这条场景用真实宿主 + 种子卡片把数据驱动的结论
 * 落到可观测量上：行数 = 进行中的卡、槽位数 = 已绑定的会话、路径数 = 主干 +
 * tick + 支线；同时钉住设置页的入口名、块标题、默认选中项与炫酷说明文案。
 *
 * 断言只读插件自己的 DOM（`data-mode`、`data-rail-*`、class、aria-label）与
 * localStorage，不读宿主内部状态。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { BOARD_MODE_KEY } from '../../src/client/board-mode.js'
import { readSessionLogs } from './session-logs.mjs'
import { startInstanceIn } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { closeBrowser, scenarioTimeout, stopScenario, waitFor, waitForLocator, watchProblems } from './harness.mjs'

const PROJECT_ID = 'e2e-board-cinema-project'
const BOARD = '.dsh-leader-agent-board'
const RAIL = '.dsh-leader-agent-board-rail'
const ROW = '[data-rail-row]'
const RAIL_SLOT = '[data-rail-slot]'
const CARD_SLOT = '.dsh-leader-agent-board-slot'
const SETTINGS_DIALOG = '[data-shortcut-modal="settings"]'
const GUIDE_ENTRY = '.dsh-leader-agent-guide-entry[data-sidebar-right-guide-entry="dsh-leader-agent-board"]'

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

/** 把该会话登记成项目。 */
function seedProject(home, session) {
  mkdirSync(join(home, 'dsh-leader-agent'), { recursive: true })
  writeFileSync(join(home, 'dsh-leader-agent', 'projects.json'), `${JSON.stringify({
    version: 1,
    projects: [{
      id: PROJECT_ID,
      name: 'cinema',
      directory: session.cwd,
      leaderSessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

/**
 * 种三张卡：两张进行中，一张已完成。
 *
 * 进行中的卡一张绑两个角色、一张绑一个角色，正好把「rail 槽位按已绑定会话数
 * 渲染」与「完成卡不参与拓扑」同时钉住。槽位都绑同一个会话：本场景只关心
 * 数量与状态，不需要真的派工。
 */
function seedCards(home, session) {
  const now = Date.now()
  writeFileSync(join(home, 'dsh-leader-agent', 'cards.json'), `${JSON.stringify({
    version: 1,
    counter: 3,
    cards: [
      {
        id: 'e2e-cinema-1',
        number: 1,
        revision: 1,
        title: '线路卡一',
        status: 'active',
        projectId: PROJECT_ID,
        slots: { dev: { sessionId: session.id }, review: { sessionId: session.id } },
        createdAt: now - 1000,
        updatedAt: now - 1000,
      },
      {
        id: 'e2e-cinema-2',
        number: 2,
        revision: 1,
        title: '线路卡二',
        status: 'active',
        projectId: PROJECT_ID,
        slots: { dev: { sessionId: session.id } },
        createdAt: now - 2000,
        updatedAt: now - 2000,
      },
      {
        id: 'e2e-cinema-3',
        number: 3,
        revision: 1,
        title: '已完成的卡',
        status: 'done',
        projectId: PROJECT_ID,
        slots: {},
        doneAt: now - 3000,
        createdAt: now - 4000,
        updatedAt: now - 3000,
      },
    ],
  }, null, 2)}\n`)
}

/** 打开设置面板；入口在「账号菜单 → 设置」里。 */
async function openSettings(page) {
  await page.getByRole('button', { name: '账号菜单', exact: true }).first().click()
  const entry = page.getByRole('menuitem', { name: '设置', exact: true }).first()
  await waitForLocator(entry, { description: '账号菜单里的设置入口', timeoutMs: 10_000 })
  await entry.click()
  const dialog = page.locator(SETTINGS_DIALOG)
  await waitForLocator(dialog, { description: '设置面板打开', timeoutMs: 15_000 })
  return dialog
}

/**
 * 打开项目 leader 的看板，返回这次走的路径。
 *
 * 刷新后右栏可能恢复成看板、guide 页或别的页：只有看板已经可见时才直接收工；
 * 否则按当前页决定「点 guide 入口」还是「新开 guide 标签再点入口」。路径返回值
 * 让用例能断言 reload 后确实需要导航，而不是碰巧被宿主恢复了看板。
 *
 * @returns {Promise<'board-restored' | 'expanded-board' | 'guide-entry' | 'new-tab-guide'>} 进入路径
 */
async function openBoard(page, session) {
  const projectRow = page.locator('.dsh-leader-agent-project-row').first()
  await waitForLocator(projectRow, { description: '项目行出现在左栏', timeoutMs: 20_000 })
  await waitFor({
    description: '项目可打开（leader 会话已就绪）',
    check: async () => (await projectRow.getAttribute('data-dead')) === null,
    timeoutMs: 20_000,
  })
  await projectRow.click()
  await waitFor({
    description: '项目行进入选中态',
    check: async () => (await projectRow.getAttribute('data-selected')) === 'true',
    timeoutMs: 15_000,
  })

  const board = page.locator(`${BOARD}:visible`)
  const guideEntry = page.locator(`${GUIDE_ENTRY}:visible`)
  const expand = page.locator('[data-sidebar-right-expand="true"]:visible').first()
  const addTab = page.locator('[data-sidebar-right-session]:visible [data-dockkit-add-tab]').first()
  const ready = async () => (await board.count()) > 0
    || (await guideEntry.count()) > 0
    || (await addTab.count()) > 0

  // 收起态只有展开按钮；已展开的右栏至少有 tab 条（add-tab 可见）
  await waitFor({
    description: '看板/guide 就绪或右栏出现展开按钮',
    check: async () => (await ready()) || (await expand.count()) > 0,
    timeoutMs: 15_000,
  })

  let expandedNow = false
  if ((await board.count()) === 0 && (await expand.count()) > 0) {
    await expand.click({ force: true })
    expandedNow = true
  }

  // 导航前确认右栏已经绑到 leader：恢复/展开时可能先画上一帧的会话页
  await waitFor({
    description: '右栏绑到 leader 且可导航',
    check: async () => {
      const rightbar = page.locator('[data-sidebar-right-session]:visible').first()
      const bound = (await rightbar.getAttribute('data-sidebar-right-session').catch(() => null)) === session.id
      return bound && await ready()
    },
    timeoutMs: 15_000,
  })

  if ((await board.count()) > 0) return expandedNow ? 'expanded-board' : 'board-restored'

  let route = 'guide-entry'
  if ((await guideEntry.count()) === 0) {
    // 右栏停在非 guide 页：新开一个 guide 标签，再点看板入口
    route = 'new-tab-guide'
    await addTab.click({ force: true })
  }
  await waitForLocator(guideEntry, { description: '右栏 guide 页的看板入口', timeoutMs: 15_000 })
  await guideEntry.click()
  await waitForLocator(board.first(), { description: '看板挂载', timeoutMs: 15_000 })
  return route
}

/** 炫酷模式的可观测事实：模式、rail/槽位与存储。 */
async function assertCinemaBoard(page) {
  assert.equal(await page.locator(`${BOARD}[data-mode="cinema"]`).count(), 1, '看板应处于炫酷模式')
  assert.equal(await page.locator(RAIL).count(), 1, '炫酷模式应渲染 rail')
  assert.equal(await page.locator(RAIL_SLOT).count(), 3, 'rail 槽位数应等于已绑定的会话')
  assert.equal(await page.locator(CARD_SLOT).count(), 0, '炫酷模式不该把会话入口留在卡内')
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), BOARD_MODE_KEY),
    'cinema',
    '显式选择应留在 localStorage',
  )
}

/** 给日志用的读数快照。 */
async function boardFacts(page) {
  return {
    mode: await page.locator(BOARD).getAttribute('data-mode'),
    rail: await page.locator(RAIL).count(),
    slot: await page.locator(CARD_SLOT).count(),
  }
}

test('工作模式默认：设置页切到炫酷后 rail 由卡片驱动，reload 保留显式选择', { timeout: scenarioTimeout() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-cinema-'))
  const mock = await startMockProvider({})
  const problems = []
  let browser = null
  let instance = null

  t.after(() => stopScenario({ browser, instance, mock, root }))

  // 第一段：让宿主建出自己的空会话，拿到 leader 的 id 与 cwd——项目注册表只在
  // 启动时读回内存，必须「先停 → seed → 用同一个根再起」。
  const first = await startInstanceIn({ root, baseUrl: mock.url })
  browser = await chromium.launch()
  const bootstrap = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const bootstrapPage = await bootstrap.newPage()
  watchProblems(bootstrapPage, problems)
  await bootstrapPage.goto(first.url, { waitUntil: 'domcontentloaded' })
  await waitForLocator(bootstrapPage.locator('div[role="textbox"][contenteditable="true"]').first(), {
    description: '第一段实例的输入框可编辑',
    timeoutMs: 20_000,
  })
  const session = await waitFor({
    description: '宿主启动后落盘一个空会话',
    check: () => firstSession(first.home),
    timeoutMs: 5_000,
  })
  await bootstrap.close()
  await first.stop({ keepRoot: true })

  seedProject(first.home, session)
  seedCards(first.home, session)

  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second
  // 不钉模式：验证默认就是工作列表。
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watchProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })

  await openBoard(page, session)
  await waitForLocator(page.locator(`${BOARD}[data-mode="work"]`), {
    description: '看板默认进入工作模式',
    timeoutMs: 15_000,
  })
  // 没有显式选择：默认模式不冒充用户选择，不写 mode key。
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), BOARD_MODE_KEY),
    null,
    '默认模式不该写显式选择',
  )
  assert.equal(await page.locator(RAIL).count(), 0, '工作模式不该渲染 rail')
  assert.equal(await page.locator(RAIL_SLOT).count(), 0, '工作模式不该有 rail 槽位')
  assert.equal(await page.locator(CARD_SLOT).count(), 3, '工作模式应把会话入口放在卡内')

  // 设置页：入口叫 Leader Agent，块标题仍是任务看板，两个模式都在这一块里。
  const dialog = await openSettings(page)
  await dialog.getByRole('button', { name: 'Leader Agent', exact: true }).click()
  const blockTitle = dialog.locator('.dsh-leader-agent-settings-title')
  await waitForLocator(blockTitle, { description: '任务看板块标题', timeoutMs: 10_000 })
  assert.equal((await blockTitle.innerText()).trim(), '任务看板', '块标题应为任务看板')
  const workOption = dialog.locator('.dsh-leader-agent-settings-option').filter({ hasText: '工作模式' }).first()
  const cinemaOption = dialog.locator('.dsh-leader-agent-settings-option').filter({ hasText: '炫酷模式' }).first()
  await waitForLocator(cinemaOption, { description: '设置页里的炫酷模式选项', timeoutMs: 10_000 })
  assert.equal(await workOption.getAttribute('aria-checked'), 'true', '默认应选中工作模式')
  assert.match(await cinemaOption.innerText(), /纯演示，社交媒体传播用/, '炫酷模式说明应写明纯演示用途')

  // 切炫酷：看板同运行时即时换模式，rail 由卡片数据驱动。
  await cinemaOption.click()
  await waitFor({
    description: '看板切到炫酷模式',
    check: async () => (await page.locator(`${BOARD}[data-mode="cinema"]`).count()) === 1,
    timeoutMs: 10_000,
  })
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), BOARD_MODE_KEY),
    'cinema',
    '显式选择应留在 localStorage',
  )

  // 行数 = 进行中的卡；rail 槽位数 = 已绑定的会话；完成卡不进拓扑。
  await waitFor({
    description: '线路图画出两行',
    check: async () => (await page.locator(ROW).count()) === 2,
    timeoutMs: 10_000,
  })
  const rows = await page.locator(ROW).evaluateAll((nodes) => nodes.map((row) => ({
    title: row.querySelector('.dsh-leader-agent-board-card-title')?.textContent ?? null,
    slots: row.querySelectorAll('[data-rail-slot]').length,
    state: row.getAttribute('data-rail-status'),
  })))
  assert.deepEqual(rows.map((row) => row.title).sort(), ['线路卡一', '线路卡二'])
  assert.deepEqual(rows.map((row) => row.slots).sort(), [1, 2], 'rail 槽位应只数已绑定的会话')
  assert.equal(await page.locator(RAIL_SLOT).count(), 3)
  assert.equal(await page.locator(`${RAIL_SLOT}[data-rail-state="empty"]`).count(), 0)
  assert.equal(await page.locator(CARD_SLOT).count(), 0, '炫酷模式会把会话入口移到 rail')

  // 支线停在执行者圆点旁，圆点本身是独立节点；aria-label 必须带上状态，
  // 不能只把状态塞进 title（读屏拿不到悬停提示）。
  const slotLabels = await page.locator(RAIL_SLOT).evaluateAll((nodes) => nodes.map((node) => ({
    label: node.getAttribute('aria-label'),
    title: node.getAttribute('title'),
  })))
  for (const { label, title } of slotLabels) {
    assert.equal(label, title, 'rail 槽位的 aria-label 应与 title 同文案')
    assert.match(label ?? '', /：/, `rail 槽位的 aria-label 缺状态：${JSON.stringify(label)}`)
  }

  // 路径数 = 主干 1 + 每行 tick + 每条支线。没有 running 的支线时没有 trail，
  // 所以这个等式能同时证明「线不是装饰」「attention 不跑光流」。
  const states = await page.locator(RAIL_SLOT).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-rail-state')))
  assert.equal(states.includes('running'), false, `种子会话是空闲的，不应出现 running：${states.join(',')}`)
  const pathCount = await page.locator(`${RAIL} path`).count()
  assert.equal(pathCount, 1 + 2 + 3, `线路应为主干 + tick + 支线，实际 ${pathCount} 条路径`)

  await page.keyboard.press('Escape')
  await waitFor({
    description: '设置面板关闭',
    check: async () => !(await page.locator(SETTINGS_DIALOG).isVisible()),
    timeoutMs: 10_000,
  })

  // 路径 A：右栏保持展开直接 reload，宿主恢复看板 tab → 不需要再导航。
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForLocator(page.locator(`${BOARD}[data-mode="cinema"]`).first(), {
    description: '刷新后宿主恢复看板',
    timeoutMs: 15_000,
  })
  const beforeA = {
    board: await page.locator(`${BOARD}:visible`).count(),
    expand: await page.locator('[data-sidebar-right-expand="true"]:visible').count(),
  }
  const routeA = await openBoard(page, session)
  assert.equal(routeA, 'board-restored', `右栏展开着 reload 应由宿主恢复看板，实际走了 ${routeA}`)
  await assertCinemaBoard(page)
  console.log(`[e2e] path A ${JSON.stringify({ beforeA, routeA, ...(await boardFacts(page)) })}`)

  // 路径 B：先把右栏切到 guide 页再收起，reload 后必须重新点 guide 入口才能回来。
  // 这条路径不能靠「宿主已经恢复看板」蒙混过关。
  const addTab = page.locator('[data-sidebar-right-session]:visible [data-dockkit-add-tab]').first()
  await addTab.click({ force: true })
  await waitForLocator(page.locator(`${GUIDE_ENTRY}:visible`), {
    description: '新开的 guide 标签页',
    timeoutMs: 15_000,
  })
  assert.equal(await page.locator(`${BOARD}:visible`).count(), 0, 'guide 标签应把看板 tab 切到后台')
  const toggle = page.locator('[data-sidebar-right-toggle]:visible').first()
  await toggle.click({ force: true })
  await waitFor({
    description: '右栏收起',
    check: async () => (await page.locator('[data-sidebar-right-expand="true"]:visible').count()) > 0,
    timeoutMs: 10_000,
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitFor({
    description: 'reload 后右栏展开按钮就绪',
    check: async () => (await page.locator(`${BOARD}:visible`).count()) > 0
      || (await page.locator('[data-sidebar-right-expand="true"]:visible').count()) > 0,
    timeoutMs: 15_000,
  })
  const beforeB = {
    board: await page.locator(`${BOARD}:visible`).count(),
    expand: await page.locator('[data-sidebar-right-expand="true"]:visible').count(),
  }
  assert.equal(beforeB.board, 0, '右栏收起时看板不应可见')
  const routeB = await openBoard(page, session)
  assert.notEqual(routeB, 'board-restored', `收起右栏后 reload 必须重新导航，实际走了 ${routeB}`)
  await waitForLocator(page.locator(`${BOARD}[data-mode="cinema"]`).first(), {
    description: '收起右栏 reload 后看板仍是炫酷模式',
    timeoutMs: 15_000,
  })
  await assertCinemaBoard(page)
  console.log(`[e2e] path B ${JSON.stringify({ beforeB, routeB, ...(await boardFacts(page)) })}`)

  await closeBrowser(browser)
  browser = null
  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
