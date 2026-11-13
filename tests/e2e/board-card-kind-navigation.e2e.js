/**
 * 看板卡面的信息层级与导航：分类在头部、会话只列已绑定的、停滞只用空心灯、
 * 链接「+N」就地展开/收起。
 *
 * 这四件事单测都碰不到——`cardKind`、`slotViewsForCard`、`isCardStalled` 是纯函数，
 * 但「卡面把分类渲染成纯文本」「空槽不占位」「展开按钮不再开详情」是渲染与交互
 * 接线，只有真实宿主里的 DOM 能证明。种子直接写进卡片库，不经过建卡工具。
 *
 * 断言落在插件自己的 DOM、class 与文案上；截图只作人工取证。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { WORKTREE, startInstanceIn } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { closeBrowser, scenarioTimeout, stopScenario, waitFor, waitForLocator, watchProblems } from './harness.mjs'

const PROJECT_ID = 'e2e-card-navigation-project'
/** 卡面根、头部身份区、会话入口、链接与溢出开关。 */
const CARD = '.dsh-leader-agent-board-card'
const CARD_ID = '.dsh-leader-agent-board-card-id'
const SLOT = '.dsh-leader-agent-board-slot'
const OVERFLOW = '.dsh-leader-agent-board-link-overflow'
const SIGNAL = '.dsh-leader-agent-board-signal'

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
      name: 'card-nav',
      directory: session.cwd,
      leaderSessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

/**
 * 种两张 active 卡。
 *
 * - 卡 1 有分类、四个链接（一个没有 URL）与两个槽位，其中 review 没有绑定会话；
 * - 卡 2 的分类不同、只绑一个会话，`updatedAt` 是 25 小时前——越过 24 小时停滞阈值。
 */
function seedCards(home, session) {
  const now = Date.now()
  // 标签故意写长：卡面链接 max-width 是 110px，8 条能稳定超过右栏一行
  const links = [
    { id: 'l1', label: 'PR-review-record-one', url: 'https://example.test/pr/1' },
    { id: 'l2', label: 'Issue-repro-steps-two', url: 'https://example.test/issues/2' },
    { id: 'l3', label: 'design-spec-three', url: 'https://example.test/design' },
    { id: 'l4', label: 'deploy-record-four', url: 'https://example.test/deploy' },
    { id: 'l5', label: 'regression-report-five', url: 'https://example.test/report' },
    { id: 'l6', label: 'retro-notes-six', url: 'https://example.test/retro' },
    { id: 'l7', label: 'benchmark-seven', url: 'https://example.test/bench' },
    { id: 'l8', label: '复盘' },
  ]
  writeFileSync(join(home, 'dsh-leader-agent', 'cards.json'), `${JSON.stringify({
    version: 1,
    counter: 2,
    cards: [
      {
        id: 'e2e-card-nav-1',
        number: 1,
        revision: 1,
        title: '卡面导航',
        kind: '研发',
        status: 'active',
        projectId: PROJECT_ID,
        links,
        slots: { dev: { sessionId: session.id }, review: {} },
        createdAt: now - 1000,
        updatedAt: now - 1000,
      },
      {
        id: 'e2e-card-nav-2',
        number: 2,
        revision: 1,
        title: '停了很久',
        kind: '文档',
        status: 'active',
        projectId: PROJECT_ID,
        slots: { dev: { sessionId: session.id } },
        createdAt: now - 25 * 60 * 60 * 1000,
        updatedAt: now - 25 * 60 * 60 * 1000,
      },
    ],
  }, null, 2)}\n`)
}

/**
 * 读一张卡的面部事实。
 *
 * @param {import('playwright').Page} page - 页面
 * @param {string} title - 卡片标题（用于定位）
 * @returns {Promise<object>} 头部文本、会话数、信号灯 class、链接数与溢出按钮读数
 */
async function readCard(page, title) {
  return page.locator(CARD).filter({ hasText: title }).first().evaluate((node, selectors) => {
    const id = node.querySelector(selectors.id)
    const row = node.querySelector(selectors.row)
    // 测量层是链接行的不可见副本（全量链接 + 「+N」），数可见入口时排除掉
    const items = row === null
      ? []
      : Array.from(row.children).filter((item) => !item.classList.contains('dsh-leader-agent-board-links-measure'))
    const overflow = items.find((item) => item.classList.contains('dsh-leader-agent-board-link-overflow'))
    const signal = node.querySelector(selectors.signal)
    return {
      header: id?.textContent ?? null,
      linkIcons: items.reduce((total, item) => total + item.querySelectorAll('svg').length, 0),
      slots: node.querySelectorAll(selectors.slot).length,
      slotNames: Array.from(node.querySelectorAll(selectors.slot)).map((item) => item.textContent),
      signalClass: signal?.className ?? null,
      links: items.filter((item) => item !== overflow).length,
      overflowText: overflow?.textContent ?? null,
      overflowExpanded: overflow?.getAttribute('aria-expanded') ?? null,
      text: node.textContent ?? '',
    }
  }, {
    id: CARD_ID,
    row: '.dsh-leader-agent-board-card-links',
    slot: SLOT,
    overflow: OVERFLOW,
    signal: SIGNAL,
  })
}

test('卡面按导航目标组织：分类在头部、空槽不占位、停滞用空心灯、+N 就地展开', { timeout: scenarioTimeout() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-card-nav-'))
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
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watchProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })

  // 打开 leader 会话：看板入口只在项目会话（leader / worker）里渲染。
  const projectRow = page.locator('.dsh-leader-agent-project-row').first()
  await waitForLocator(projectRow, { description: '项目行出现在左栏', timeoutMs: 20_000 })
  await waitFor({
    description: '项目可打开（leader 会话已就绪）',
    check: async () => (await projectRow.getAttribute('data-dead')) === null,
    timeoutMs: 20_000,
  })
  await projectRow.click()
  await waitFor({
    description: '项目行进入选中态（当前会话已切到 leader）',
    check: async () => (await projectRow.getAttribute('data-selected')) === 'true',
    timeoutMs: 15_000,
  })

  await waitForLocator(page.locator('[data-sidebar-right-expand="true"]').first(), {
    description: '右栏的展开按钮',
    timeoutMs: 15_000,
  })
  await page.locator('[data-sidebar-right-expand="true"]').first().click({ force: true })
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

  // 看板首帧：卡面渲染出来即可读数，行数由断言自己核对。
  await waitForLocator(page.locator(CARD).filter({ hasText: '卡面导航' }), {
    description: '卡 1 出现在看板里',
    timeoutMs: 15_000,
  })
  const card1 = await readCard(page, '卡面导航')

  // 头部：只读身份是「#编号 / 分类」，分类以纯文本出现在编号后面。
  assert.equal(card1.header?.includes('#1'), true, `头部应含 #1，实际 ${JSON.stringify(card1.header)}`)
  assert.equal(card1.header?.includes('研发'), true, `头部应含分类「研发」，实际 ${JSON.stringify(card1.header)}`)
  assert.equal(card1.header?.includes('/'), true, `编号与分类之间应有分隔符，实际 ${JSON.stringify(card1.header)}`)

  // 会话行只列已绑定的角色：种了 dev 与 review，review 没有会话，不占位。
  assert.equal(card1.slots, 1, `会话入口应只有已绑定的 1 个，实际 ${card1.slots}：${JSON.stringify(card1.slotNames)}`)

  // 链接收起态：放不下时出现「+N」，展开后全部直出，但不是打开详情。
  // 链接保持纯文本：一行多条时图标会连成点阵，比标签本身更抢眼
  assert.equal(card1.linkIcons, 0, `卡面链接不该有前置图标，实际 ${card1.linkIcons} 个`)

  assert.notEqual(card1.overflowText, null, '链接行应有溢出开关')
  assert.equal(card1.overflowExpanded, 'false', '溢出开关初始应是收起态')
  assert.equal(card1.overflowText.startsWith('+'), true, `收起态文案应是 +N，实际 ${JSON.stringify(card1.overflowText)}`)
  const collapsedLinks = card1.links
  assert.ok(collapsedLinks < 8, `收起态不应把 8 个链接全放出来，实际 ${collapsedLinks}`)

  // 测量层里还有一份不可见的「+N」副本（tabIndex -1）；可点的那个带 aria-expanded
  const card1Locator = page.locator(CARD).filter({ hasText: '卡面导航' }).first()
  const overflowButton = card1Locator.locator(`${OVERFLOW}[aria-expanded]`)
  await overflowButton.click()
  await waitFor({
    description: '溢出开关变成展开态',
    check: async () => (await readCard(page, '卡面导航')).overflowExpanded === 'true',
    timeoutMs: 10_000,
  })
  const expanded = await readCard(page, '卡面导航')
  assert.equal(expanded.overflowText, '收起', '展开后开关文案应是「收起」')
  // 8 个链接全部直出，溢出开关变成「收起」；不再借用详情浮层。
  assert.equal(expanded.links, 8, `展开后应有 8 个链接，实际 ${expanded.links}`)
  assert.ok(expanded.links > collapsedLinks, '展开后应比收起态多出被藏的链接')

  await overflowButton.click()
  await waitFor({
    description: '溢出开关回到收起态',
    check: async () => (await readCard(page, '卡面导航')).overflowExpanded === 'false',
    timeoutMs: 10_000,
  })
  assert.equal((await readCard(page, '卡面导航')).links, collapsedLinks, '收起后应回到收起态的链接数')

  // 停滞卡：只靠空心灯表达，信号灯同时带档位 class 与 hollow 形状 class。
  const card2 = await readCard(page, '停了很久')
  assert.equal(card2.signalClass?.includes('dsh-leader-agent-board-signal-hollow'), true, `停滞卡应是空心灯，实际 class ${JSON.stringify(card2.signalClass)}`)
  assert.equal(card2.header?.includes('文档'), true, `卡 2 头部应含分类「文档」，实际 ${JSON.stringify(card2.header)}`)
  // 停滞不再写时长，只由空心灯表达。这条必须查真正 stagnant 的卡 2：卡 1 一秒前
  // 更新过，无论实现改没改都不会出现「停滞」，查它等于没断言。
  assert.equal(card2.text.includes('停滞'), false, `停滞卡不该出现「停滞」文案：${card2.text}`)

  const artifacts = join(WORKTREE, '.dev', 'e2e-artifacts', `board-card-kind-navigation-${process.pid}`)
  mkdirSync(artifacts, { recursive: true })
  await page.screenshot({ path: join(artifacts, 'board-cards.png') })
  console.log(`[e2e] 截图 ${join(artifacts, 'board-cards.png')}`)

  await closeBrowser(browser)
  browser = null
  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
