/**
 * 英文界面：项目区块、看板入口与 tab 标题走 en 字典。
 *
 * 单测只能证明字典里有两个键；「注册期 thunk 真读到了当前语言」「slot 的 `t`
 * 真的注入了」只有真实宿主能证明。这个场景把 `locale: 'en-US'` 的浏览器开到
 * 项目会话里，逐层读左栏标题、guide 胶囊与看板 tab chip 的文案。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { startInstanceIn } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { closeBrowser, scenarioTimeout, stopScenario, waitFor, waitForLocator, watchProblems } from './harness.mjs'

const PROJECT_ID = 'e2e-i18n-project'
/** 中文文案不该出现在英文界面里；项目名固定 ASCII，不会误伤。 */
const CJK = /[\u4e00-\u9fff]/

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
      name: 'i18n',
      directory: session.cwd,
      leaderSessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

test('英文界面：左栏标题、guide 入口与看板 tab 标题都不是中文', { timeout: scenarioTimeout() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-i18n-'))
  const mock = await startMockProvider({})
  const problems = []
  let browser = null
  let instance = null

  t.after(() => stopScenario({ browser, instance, mock, root }))

  // 第一段：宿主建出自己的空会话，拿到 leader 的 id 与 cwd。项目注册表只在启动
  // 时读回内存，必须「先停 → seed → 用同一个根再起」。
  const first = await startInstanceIn({ root, baseUrl: mock.url })
  browser = await chromium.launch()
  const bootstrap = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
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

  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watchProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })

  // 宿主首次启动会弹预览版说明，按钮文案随语言变；没弹就继续。
  try { await page.getByRole('button', { name: 'Continue', exact: true }).first().click({ timeout: 4000 }) } catch { /* 没弹窗 */ }

  const section = page.locator('.dsh-leader-agent-project-section')
  await waitForLocator(section, { description: '项目区块挂载', timeoutMs: 20_000 })
  await waitForLocator(page.locator('.dsh-leader-agent-project-header-label', { hasText: 'Projects' }), {
    description: '区块标题是英文 Projects',
    timeoutMs: 10_000,
  })
  assert.equal(CJK.test(await section.innerText()), false, `左栏出现中文：${await section.innerText()}`)

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
  const guideTitle = await guideEntry.locator('.dsh-leader-agent-guide-entry-title').innerText()
  assert.equal(guideTitle, 'Board', 'guide 入口标题应来自 en 字典')
  const guideText = await guideEntry.innerText()
  assert.equal(CJK.test(guideText), false, `guide 入口出现中文：${guideText}`)

  await guideEntry.click()

  // tab chip 的标题是宿主的 `title` thunk 与 `sidebar.right.pane.tab.title` 席位共同
  // 决定的；两者任一漏翻都会在这里显示中文。
  const tabTitle = page.locator('span[data-sidebar-right-tab]').filter({ hasText: 'Board' }).first()
  await waitForLocator(tabTitle, { description: '看板 tab 标题是英文 Board', timeoutMs: 15_000 })
  assert.equal((await tabTitle.innerText()).trim(), 'Board')

  const emptyTitle = page.locator('.dsh-leader-agent-board-empty-title')
  await waitForLocator(emptyTitle, { description: '空看板的标题出现', timeoutMs: 15_000 })
  assert.equal((await emptyTitle.innerText()).trim(), 'No cards yet')
  const board = page.locator('.dsh-leader-agent-board-list').first()
  assert.equal(CJK.test(await board.innerText()), false, `看板出现中文：${await board.innerText()}`)

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
  await closeBrowser(browser)
  browser = null
})
