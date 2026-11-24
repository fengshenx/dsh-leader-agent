/**
 * 看板线路图（炫酷模式）：默认进 cinema、rail 的行/槽位由卡片数据驱动、切到
 * 工作模式后 rail 消失。
 *
 * 线路图的几何由渲染后实测决定，单测只能钉住路径规划，钉不住「DOM 里真的画了
 * 几条线、几个执行者节点」。这条场景用真实宿主 + 种子卡片把数据驱动的结论
 * 落到可观测量上：行数 = 进行中的卡、槽位数 = 已绑定的会话、路径数 = 主干 +
 * tick + 支线；再经设置页切到工作模式，验证同一块看板换模式后 rail 不渲染。
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
import { BOARD_DEFAULT_KEY, BOARD_MODE_KEY, BOARD_MODE_WORK } from '../../src/client/board-mode.js'
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

/** 打开项目 leader 的看板；刷新后右栏可能已经被宿主恢复，不重复点开。 */
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
  const board = page.locator(BOARD)
  const expand = page.locator('[data-sidebar-right-expand="true"]').first()
  // 刷新恢复布局时右栏可能已经挂在看板上；只有收起态才需要重新展开。
  await waitFor({
    description: '看板已恢复或右栏出现展开按钮',
    check: async () => (await board.count()) > 0 || (await expand.count()) > 0,
    timeoutMs: 15_000,
  })
  if ((await board.count()) === 0) {
    await expand.click({ force: true })
    await waitFor({
      description: '右栏绑定到 leader 会话',
      check: async () => {
        const rightbar = page.locator('[data-sidebar-right-session]').first()
        return (await rightbar.getAttribute('data-sidebar-right-session').catch(() => null)) === session.id
      },
      timeoutMs: 15_000,
    })
    const guideEntry = page.locator(
      '.dsh-leader-agent-guide-entry[data-sidebar-right-guide-entry="dsh-leader-agent-board"]',
    )
    await waitForLocator(guideEntry, { description: '右栏 guide 页的看板入口', timeoutMs: 15_000 })
    await guideEntry.click()
  }
  await waitForLocator(board.first(), { description: '看板挂载', timeoutMs: 15_000 })
}

test('线路图默认炫酷：rail 由卡片驱动，切工作模式后 rail 消失', { timeout: scenarioTimeout() }, async (t) => {
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
  // 不钉模式：这条场景要验证「新装默认炫酷」本身。bootstrap 的空数据实例已经
  // 写下 fresh 标记，第二次启动按新装默认走 cinema。
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watchProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })

  await openBoard(page, session)
  await waitForLocator(page.locator(`${BOARD}[data-mode="cinema"]`), {
    description: '看板默认进入炫酷模式',
    timeoutMs: 15_000,
  })
  // 偏好没有任何显式依据，宿主判定的默认值缓存为 cinema——两者合起来才是「新装
  // 默认炫酷」，只看 data-mode 分不出「用户选的」还是「默认来的」。
  const stored = await waitFor({
    description: '宿主默认模式缓存为 cinema',
    check: () => page.evaluate(({ defaultKey, modeKey }) => {
      if (localStorage.getItem(modeKey) !== null) return null
      return localStorage.getItem(defaultKey) === 'cinema' ? { mode: null, fallback: 'cinema' } : null
    }, { defaultKey: BOARD_DEFAULT_KEY, modeKey: BOARD_MODE_KEY }),
    timeoutMs: 15_000,
  })
  assert.deepEqual(stored, { mode: null, fallback: 'cinema' })

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

  // 设置页：预览圆点取主题强调色（浅色宿主的 accent 是蓝的，固定琥珀会误导）。
  const dialog = await openSettings(page)
  await dialog.getByRole('button', { name: '任务看板', exact: true }).click()
  const preview = dialog.locator('.dsh-leader-agent-settings-option').filter({ hasText: '炫酷模式' }).first()
  await waitForLocator(preview, { description: '设置页里的炫酷模式选项', timeoutMs: 10_000 })
  const colors = await dialog.evaluate((node) => {
    const dot = node.querySelector('.dsh-leader-agent-settings-preview-dot')
    const radio = node.querySelector('.dsh-leader-agent-settings-option-selected .dsh-leader-agent-settings-radio')
    return {
      dot: dot === null ? null : getComputedStyle(dot).fill,
      radio: radio === null ? null : getComputedStyle(radio).borderTopColor,
    }
  })
  assert.notEqual(colors.dot, null, '缺设置页预览圆点')
  assert.equal(colors.dot, colors.radio, `预览圆点应取主题强调色，实际 fill=${colors.dot} / accent=${colors.radio}`)

  // 切工作：看板同运行时即时换模式，rail 不再渲染，卡内会话入口回来。
  const workOption = dialog.locator('.dsh-leader-agent-settings-option').filter({ hasText: '工作模式' }).first()
  await workOption.click()
  await waitFor({
    description: '看板切到工作模式',
    check: async () => (await page.locator(`${BOARD}[data-mode="work"]`).count()) === 1,
    timeoutMs: 10_000,
  })
  assert.equal(await page.locator(RAIL).count(), 0, '工作模式不该渲染 rail')
  assert.equal(await page.locator(RAIL_SLOT).count(), 0, '工作模式不该有 rail 槽位')
  assert.equal(await page.locator(CARD_SLOT).count(), 3, '工作模式应把会话入口放回卡内')
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), BOARD_MODE_KEY),
    BOARD_MODE_WORK,
    '切模式应把显式选择写进 localStorage',
  )

  await page.keyboard.press('Escape')
  await waitFor({
    description: '设置面板关闭',
    check: async () => !(await page.locator(SETTINGS_DIALOG).isVisible()),
    timeoutMs: 10_000,
  })

  // 刷新后仍是工作模式：显式选择压过宿主默认，rail 不该回来。
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openBoard(page, session)
  await waitForLocator(page.locator(`${BOARD}[data-mode="work"]`), {
    description: '刷新后看板仍是工作模式',
    timeoutMs: 15_000,
  })
  assert.equal(await page.locator(RAIL).count(), 0, '刷新后工作模式不该渲染 rail')
  assert.equal(await page.locator(RAIL_SLOT).count(), 0, '刷新后工作模式不该有 rail 槽位')
  assert.equal(await page.locator(CARD_SLOT).count(), 3, '刷新后会话入口仍在卡内')
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), BOARD_MODE_KEY),
    BOARD_MODE_WORK,
    '刷新后显式选择仍在 localStorage',
  )

  await closeBrowser(browser)
  browser = null
  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
