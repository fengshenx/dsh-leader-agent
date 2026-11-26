/**
 * 项目区块的左栏落点与最小几何守卫：先守落点（工作区列表之上、不退回栏底），
 * 再守行高与小节标题/行首/标题左缘跟宿主一致。
 *
 * 落点部分守 portal 结构：宿主 0.2.2 把面板列表与工作区包进滚动网格后，老锚点
 * 失效会让区块静默退回 footer（宽度被压成 4px）。几何部分只守
 * `2026-11-14-project-section-row-geometry` 修过的那个 bug：宿主 0.2.2
 * 把工作区行压到 32px 并让内容行吃 paint-inset 后，项目区块照 0.2.1 的数值抄，
 * 「项目」比「工作区」右移一截、项目行比宿主行矮 2px。e2e 不测样式，但这四条
 * 读数量的是**两个宿主元素之间的相对偏移**，不是某个颜色/字号的具体值，换宿主
 * 版本也不该漂移；全量像素对齐（内边距、边框、截图）改走人工取证。
 *
 * 基准始终取宿主同一元素：行高对宿主工作区行、图标左缘对宿主行图标、标题左缘对
 * 宿主行标题、小节标题左缘对宿主 section label（从 hostRow 向上找同 section，
 * 不取全局第一条）。先种项目再起第二段实例：项目注册表只在启动时读回内存。
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
      id: 'e2e-alignment-project',
      name: '对齐项目',
      directory: session.cwd,
      leaderSessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

/**
 * 读两边的行高与左缘。宿主选择器用 CSS Module 类名的稳定子串（哈希前缀随构建变）。
 *
 * @param {import('playwright').Page} page - 页面
 * @returns {Promise<object>} 项目行、项目小节标题与宿主对应元素的四条读数
 */
async function readGeometry(page) {
  return page.evaluate(() => {
    /** 元素左边缘；缺失时返回 null。 */
    const leftOf = (element) => (element === null ? null : Math.round(element.getBoundingClientRect().left * 100) / 100)
    const heightOf = (element) => (element === null ? null : Math.round(element.getBoundingClientRect().height * 100) / 100)

    const ourRow = document.querySelector('.dsh-leader-agent-project-row')
    const ourLabel = document.querySelector('.dsh-leader-agent-project-header-label')
    const ourIcon = ourRow?.querySelector('.dsh-leader-agent-project-lead') ?? null
    const ourTitle = ourRow?.querySelector('.dsh-leader-agent-project-title') ?? null

    // 从宿主工作区行往上找同一个小节，取该小节的 header；不要拿全局第一条。
    const hostRow = document.querySelector('[class*="projectRow"]')
    const hostIcon = hostRow?.querySelector('svg') ?? null
    const hostTitle = hostRow?.querySelector('[class*="title"]') ?? null
    let hostHeader = null
    for (let node = hostRow?.parentElement ?? null; node !== null; node = node.parentElement) {
      hostHeader = node.querySelector('[class*="sectionHeader"]')
      if (hostHeader !== null) break
    }
    const hostLabel = hostHeader?.querySelector('[class*="sectionLabel"]') ?? null
    const hostLabelText = hostLabel?.textContent?.trim() ?? null

    return {
      ourRowHeight: heightOf(ourRow),
      hostRowHeight: heightOf(hostRow),
      ourIconLeft: leftOf(ourIcon),
      hostIconLeft: leftOf(hostIcon),
      ourTitleLeft: leftOf(ourTitle),
      hostTitleLeft: leftOf(hostTitle),
      ourLabelLeft: leftOf(ourLabel),
      hostLabelLeft: leftOf(hostLabel),
      hostLabelText,
    }
  })
}

/**
 * 落点读数：项目区块应进入工作区容器，而不是退回 footer。
 *
 * @param {import('playwright').Page} page - 页面
 * @returns {Promise<object>} 落点读数
 */
async function readPlacement(page) {
  return page.evaluate(() => {
    const section = document.querySelector('.dsh-leader-agent-project-section')
    const host = section?.closest('[data-dsh-leader-agent-projects]') ?? null
    const region = document.querySelector('[class*="regionArea"]')
    const nav = region?.parentElement?.querySelector('nav') ?? null
    const navParent = nav?.parentElement ?? null
    const scrollGrid = navParent !== null
      && (navParent.hasAttribute('data-sidebar-scrollport') || getComputedStyle(navParent).display === 'grid')
    const expectedParent = scrollGrid ? region : navParent
    const workspace = region === null
      ? null
      : Array.from(region.children).find((child) => child !== host) ?? null
    const key = host !== null ? 'host' : section?.closest('[class*="footArea"]') !== null ? 'footer' : 'elsewhere'
    const sectionRect = section?.getBoundingClientRect() ?? null
    return {
      key,
      regionFound: region !== null,
      navFound: nav !== null,
      scrollGrid,
      hostFound: host !== null,
      hostParentIsExpected: host !== null && expectedParent !== null && host.parentElement === expectedParent,
      inFooter: section !== null && section.closest('[class*="footArea"]') !== null,
      afterNav: nav !== null && section !== null
        && (nav.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      aboveWorkspace: workspace !== null && section !== null
        && (section.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      sectionWidth: sectionRect === null ? 0 : Math.round(sectionRect.width),
    }
  })
}

test('项目区块落在工作区列表之上，行高与左缘跟宿主一致', { timeout: scenarioTimeout() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-alignment-'))
  const mock = await startMockProvider({})
  const problems = []
  let browser = null
  let instance = null

  t.after(() => stopScenario({ browser, instance, mock, root }))

  // 第一段：让宿主建出自己的空会话，拿到 leader 的 id 与 cwd。
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

  // 第二段：同一个数据根启动，项目在启动时被读进内存。
  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watchProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })

  await waitForLocator(page.locator('.dsh-leader-agent-project-row').first(), {
    description: '项目行出现在左栏',
    timeoutMs: 20_000,
  })
  // 宿主的工作区行是几何基准：没有它这条场景证明不了任何对齐。
  await waitForLocator(page.locator('[class*="projectRow"]').first(), {
    description: '宿主工作区行出现在左栏',
    timeoutMs: 20_000,
  })
  // 落点：mount 先落在 footer，portal 的 effect 随后才搬走。连续三次读到同一个
  // 落点才判定稳定，成功与失败都按同一口径收敛。
  let previous = null
  let streak = 0
  const placement = await waitFor({
    description: '项目区块落点稳定（进入落点容器或停在 footer）',
    check: async () => {
      const reading = await readPlacement(page)
      streak = previous !== null && previous.key === reading.key ? streak + 1 : 1
      previous = reading
      return streak >= 3 ? reading : null
    },
  })
  const placementReading = JSON.stringify(placement)
  assert.equal(placement.navFound, true, `落点：左栏里应有面板列表 nav；读数 ${placementReading}`)
  assert.equal(placement.regionFound, true, `落点：左栏里应有工作区容器；读数 ${placementReading}`)
  assert.equal(placement.hostFound, true, `落点：项目区块应被 portal 搬进左栏落点容器；读数 ${placementReading}`)
  assert.equal(placement.inFooter, false, `落点：项目区块不应退回栏底的 footer 槽；读数 ${placementReading}`)
  assert.ok(
    placement.sectionWidth >= 100,
    `落点：项目区块宽度不应被网格压成竖条（朴素写法实测 4px）；读数 ${placementReading}`,
  )
  assert.equal(
    placement.hostParentIsExpected,
    true,
    `落点：落点应是工作区容器（0.2.2）或左栏根（0.2.1），不能是滚动网格本身；读数 ${placementReading}`,
  )
  assert.equal(placement.afterNav, true, `落点：项目区块应排在面板列表 nav 之后；读数 ${placementReading}`)
  assert.equal(placement.aboveWorkspace, true, `落点：项目区块应排在工作区列表之前；读数 ${placementReading}`)

  // 项目行、标题与小节标题是多次渲染（列表先到、展开态后到），等两边的四条读数都齐全再断言。
  const geometry = await waitFor({
    description: '项目区块与工作区行的四条读数齐全',
    check: async () => {
      const reading = await readGeometry(page)
      return reading.ourRowHeight !== null && reading.hostRowHeight !== null
        && reading.ourIconLeft !== null && reading.hostIconLeft !== null
        && reading.ourTitleLeft !== null && reading.hostTitleLeft !== null
        && reading.ourLabelLeft !== null && reading.hostLabelLeft !== null
        && reading.hostLabelText !== null
        ? reading
        : null
    },
  })

  const reading = JSON.stringify(geometry)
  // 四条都是「本区块 vs 宿主同一元素」的相对读数；容差 1px 吃掉亚像素取整，
  // 不放宽到「看起来差不多」。
  assert.ok(
    Math.abs(geometry.ourRowHeight - geometry.hostRowHeight) <= 1,
    `几何：项目行行高应与宿主工作区行一致；读数 ${reading}`,
  )
  assert.ok(
    Math.abs(geometry.ourIconLeft - geometry.hostIconLeft) <= 1,
    `几何：项目行行首图标应与宿主工作区行图标同一左边缘；读数 ${reading}`,
  )
  assert.ok(
    Math.abs(geometry.ourTitleLeft - geometry.hostTitleLeft) <= 1,
    `几何：项目行标题应与宿主工作区行标题同一左边缘；读数 ${reading}`,
  )
  // 小节标题：宿主 sectionLabel 自带 left:-1px，允许 1px 差异。
  assert.ok(
    Math.abs(geometry.ourLabelLeft - geometry.hostLabelLeft) <= 1,
    `几何：「项目」标题应与「工作区」标题同一左边缘；读数 ${reading}`,
  )
  assert.equal(
    geometry.hostLabelText,
    '工作区',
    `几何：小节标题必须绑定到宿主「工作区」那一条，实际 ${geometry.hostLabelText}；读数 ${reading}`,
  )

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
