/**
 * 项目区块的几何与宿主工作区树对齐。
 *
 * 守的是一组纯样式回归：宿主 0.2.2 把「工作区」行从 34px 压到 32px，并让内容行
 * 用 3px 透明边框吃掉 paint-inset（左内容起点 12px、行高 32px），小节标题的左内边距
 * 也从 4px 提到 `--dsh-sidebar-row-padding`（12px）。本区块原先照 0.2.1 的数值抄：
 * 行高 34、`padding: 0 8px`、标题前多一个 16px 图标槽，在 0.2.2 上「项目」比
 * 「工作区」右移 13px，项目行比它自己的会话行与工作区行左移 4px、高 2px。
 *
 * 断言把**宿主的同一元素**当基准：行高、左右内边距、边框、行首图标与标题的左边缘，
 * 读数两边一起报。宿主再改这两处几何时场景先红，而不是靠人眼在截图里找。
 *
 * 先种项目再起第二段实例：项目注册表只在启动时读回内存（同 board-done-paging）。
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
 * 读一次两边的几何。宿主选择器用 CSS Module 类名的稳定子串（哈希前缀随构建变）。
 *
 * @param {import('playwright').Page} page - 页面
 * @returns {Promise<object>} 左右两边的行高、内边距、边框与左边缘
 */
async function readGeometry(page) {
  return page.evaluate(() => {
    /** 一个元素的行几何；缺失时返回 null。 */
    const box = (element) => {
      if (element === null) return null
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        left: Math.round(rect.left * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        borderLeftWidth: style.borderLeftWidth,
        borderRightWidth: style.borderRightWidth,
      }
    }
    /** 元素左边缘；缺失时返回 null。 */
    const leftOf = (element) => (element === null ? null : Math.round(element.getBoundingClientRect().left * 100) / 100)

    const ourRow = document.querySelector('.dsh-leader-agent-project-row')
    const ourLabel = document.querySelector('.dsh-leader-agent-project-header-label')
    const ourIcon = ourRow?.querySelector('.dsh-leader-agent-project-lead') ?? null
    const ourTitle = ourRow?.querySelector('.dsh-leader-agent-project-title') ?? null

    const hostHeader = document.querySelector('[class*="sectionHeader"]')
    const hostLabel = hostHeader?.querySelector('[class*="sectionLabel"]') ?? null
    const hostRow = document.querySelector('[class*="projectRow"]')
    const hostIcon = hostRow?.querySelector('svg') ?? null
    const hostTitle = hostRow?.querySelector('[class*="title"]') ?? null

    return {
      ourRow: box(ourRow),
      hostRow: box(hostRow),
      ourIconLeft: leftOf(ourIcon),
      hostIconLeft: leftOf(hostIcon),
      ourTitleLeft: leftOf(ourTitle),
      hostTitleLeft: leftOf(hostTitle),
      ourLabelLeft: leftOf(ourLabel),
      hostLabelLeft: leftOf(hostLabel),
    }
  })
}

test('项目区块的行高、内边距与左边缘跟宿主工作区树一致', { timeout: scenarioTimeout() }, async (t) => {
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
  // 项目行与标题是两次渲染（列表先到、展开态后到），等两边读数都落到同一形状再断言。
  const geometry = await waitFor({
    description: '项目区块与工作区行的几何读数齐全',
    check: async () => {
      const reading = await readGeometry(page)
      return reading.ourRow !== null && reading.hostRow !== null
        && reading.ourIconLeft !== null && reading.hostIconLeft !== null
        && reading.ourTitleLeft !== null && reading.hostTitleLeft !== null
        && reading.ourLabelLeft !== null && reading.hostLabelLeft !== null
        ? reading
        : null
    },
  })

  const reading = JSON.stringify(geometry)
  assert.ok(geometry.ourRow !== null, `项目行应有可读的盒模型；读数 ${reading}`)
  assert.ok(geometry.hostRow !== null, `宿主工作区行应有可读的盒模型；读数 ${reading}`)
  // 行高：0.2.1 是 34、0.2.2 起是 32；本区块必须跟宿主同一版，而不是写死其中一版。
  assert.ok(
    Math.abs(geometry.ourRow.height - geometry.hostRow.height) <= 1,
    `项目行行高应与宿主工作区行一致；读数 ${reading}`,
  )
  assert.equal(
    geometry.ourRow.paddingLeft,
    geometry.hostRow.paddingLeft,
    `项目行左内边距应与宿主工作区行一致（0.2.2 起是 paint-inset 之外的 9px）；读数 ${reading}`,
  )
  assert.equal(
    geometry.ourRow.paddingRight,
    geometry.hostRow.paddingRight,
    `项目行右内边距应与宿主工作区行一致；读数 ${reading}`,
  )
  assert.equal(
    geometry.ourRow.borderLeftWidth,
    geometry.hostRow.borderLeftWidth,
    `项目行左透明边框应与宿主工作区行一致（paint-inset）；读数 ${reading}`,
  )
  assert.equal(
    geometry.ourRow.borderRightWidth,
    geometry.hostRow.borderRightWidth,
    `项目行右透明边框应与宿主工作区行一致（paint-inset）；读数 ${reading}`,
  )
  // 左边缘：行首槽位与标题必须落在宿主行同一列，否则「项目」比「工作区」缩进一截。
  assert.ok(
    Math.abs(geometry.ourIconLeft - geometry.hostIconLeft) <= 1,
    `项目行行首图标应与宿主工作区行图标同一左边缘；读数 ${reading}`,
  )
  assert.ok(
    Math.abs(geometry.ourTitleLeft - geometry.hostTitleLeft) <= 1,
    `项目行标题应与宿主工作区行标题同一左边缘；读数 ${reading}`,
  )
  // 小节标题：宿主 sectionLabel 自带 left:-1px，允许 1px 差异。
  assert.ok(
    Math.abs(geometry.ourLabelLeft - geometry.hostLabelLeft) <= 1,
    `「项目」标题应与「工作区」标题同一左边缘；读数 ${reading}`,
  )

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
