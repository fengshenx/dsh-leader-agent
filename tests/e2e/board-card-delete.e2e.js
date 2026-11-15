/**
 * 卡片详情删除：二次确认、取消保留、确认后卡片从看板与卡片库消失。
 *
 * 单测覆盖存储删除与确认文案；「按钮真的在详情里」「确认框打开时详情收起」
 * 「删完看板立刻消失」只有真实宿主 DOM 能证明。种子直接写卡片库。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { WORKTREE, startInstanceIn } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { closeBrowser, scenarioTimeout, stopScenario, waitFor, waitForLocator, watchProblems } from './harness.mjs'

const PROJECT_ID = 'e2e-card-delete-project'
const CARD = '.dsh-leader-agent-board-card'
const DETAIL = '.dsh-leader-agent-card-detail'
const DELETE_ENTRY = '.dsh-leader-agent-card-detail-delete'
const DIALOG_TITLE = '.dsh-leader-agent-modal-title'

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
      name: 'card-delete',
      directory: session.cwd,
      leaderSessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

/** 种两张卡：删一张，另一张必须留着。 */
function seedCards(home, session) {
  const now = Date.now()
  writeFileSync(join(home, 'dsh-leader-agent', 'cards.json'), `${JSON.stringify({
    version: 1,
    counter: 2,
    cards: [
      {
        id: 'e2e-card-delete-1',
        number: 1,
        revision: 1,
        title: '待删卡',
        spec: '这张卡只用于删除场景。',
        status: 'active',
        projectId: PROJECT_ID,
        slots: { dev: { sessionId: session.id } },
        createdAt: now - 1000,
        updatedAt: now - 1000,
      },
      {
        id: 'e2e-card-delete-2',
        number: 2,
        revision: 1,
        title: '留下的卡',
        status: 'active',
        projectId: PROJECT_ID,
        slots: {},
        createdAt: now - 900,
        updatedAt: now - 900,
      },
    ],
  }, null, 2)}\n`)
}

/** 读卡片库里的标题。 */
function cardTitles(home) {
  const raw = JSON.parse(readFileSync(join(home, 'dsh-leader-agent', 'cards.json'), 'utf8'))
  return raw.cards.map((card) => card.title)
}

test('详情里删卡：先确认、可取消，确认后卡片从看板与卡片库消失', { timeout: scenarioTimeout() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-card-delete-'))
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
  // 宿主新版本会先弹一次「预览版说明」；它盖住左栏，先按界面上的继续关掉。
  const welcome = page.getByRole('button', { name: '继续', exact: true })
  if (await welcome.count() > 0) await welcome.first().click()

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
  await guideEntry.click()

  const target = page.locator(CARD).filter({ hasText: '待删卡' }).first()
  await waitForLocator(target, { description: '待删卡出现在看板里', timeoutMs: 15_000 })
  await target.click()
  await waitForLocator(page.locator(DETAIL), { description: '卡片详情打开', timeoutMs: 10_000 })

  const artifacts = join(WORKTREE, '.dev', 'e2e-artifacts', `board-card-delete-${process.pid}`)
  mkdirSync(artifacts, { recursive: true })
  await page.screenshot({ path: join(artifacts, 'card-detail.png'), animations: 'disabled' })

  // 第一次：打开确认框，取消后详情与卡片都还在。
  await page.locator(DELETE_ENTRY).click()
  await waitForLocator(page.locator(DIALOG_TITLE), { description: '删除确认框打开', timeoutMs: 10_000 })
  await page.screenshot({ path: join(artifacts, 'delete-confirm.png'), animations: 'disabled' })
  assert.equal(await page.locator(DIALOG_TITLE).textContent(), '删除卡片')
  assert.equal(await page.locator(DETAIL).count(), 0, '确认框打开时详情应收起，避免两层 modal 抢 Escape')
  assert.match(await page.locator('.dsh-leader-agent-modal-description').textContent(), /删除后不可恢复/)
  const dialogFooter = page.locator('.dsh-leader-agent-modal-footer')
  await dialogFooter.getByRole('button', { name: '取消', exact: true }).click()
  await waitForLocator(page.locator(DETAIL), { description: '取消后详情重新打开', timeoutMs: 10_000 })
  assert.equal(await page.locator(CARD).filter({ hasText: '待删卡' }).count(), 1)
  assert.deepEqual(cardTitles(second.home), ['待删卡', '留下的卡'])

  // 第二次：确认删除，看板立即摘卡，卡片库同步落盘。
  await page.locator(DELETE_ENTRY).click()
  await waitForLocator(page.locator(DIALOG_TITLE), { description: '删除确认框再次打开', timeoutMs: 10_000 })
  await page.locator('.dsh-leader-agent-modal-footer')
    .getByRole('button', { name: '删除', exact: true })
    .click()
  await waitFor({
    description: '待删卡从看板消失',
    check: async () => (await page.locator(CARD).filter({ hasText: '待删卡' }).count()) === 0,
    timeoutMs: 10_000,
  })
  await waitFor({
    description: '卡片库落盘只剩另一张卡',
    check: () => cardTitles(second.home).length === 1,
    timeoutMs: 10_000,
  })
  assert.deepEqual(cardTitles(second.home), ['留下的卡'])
  assert.equal(await page.locator(DETAIL).count(), 0, '删除成功后详情应关闭')
  assert.equal(await page.getByText('留下的卡', { exact: true }).count() > 0, true)
  await page.screenshot({ path: join(artifacts, 'board-after-delete.png'), animations: 'disabled' })
  console.log(`[e2e] 截图 ${join(artifacts, 'board-after-delete.png')}`)

  await closeBrowser(browser)
  browser = null
  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
