/**
 * 英文界面的链接编辑器：共享校验错误由编辑器映射成 locale key，而不是把
 * `src/shared/card-links.js` 的中文说明直接显示出来。
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
import { LOCALE_UI } from '../../src/client/locales.js'

const PROJECT_ID = 'e2e-i18n-link-editor'
const CARD_TITLE = 'i18n link editor'
const en = LOCALE_UI.en
const CJK = /[\u4e00-\u9fff]/

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

function seedProject(home, session) {
  mkdirSync(join(home, 'dsh-leader-agent'), { recursive: true })
  writeFileSync(join(home, 'dsh-leader-agent', 'projects.json'), `${JSON.stringify({
    version: 1,
    projects: [{
      id: PROJECT_ID,
      name: 'i18n-link',
      directory: session.cwd,
      leaderSessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

function seedCard(home, session) {
  const now = Date.now()
  writeFileSync(join(home, 'dsh-leader-agent', 'cards.json'), `${JSON.stringify({
    version: 1,
    counter: 1,
    cards: [{
      id: 'e2e-i18n-link-card',
      number: 1,
      revision: 1,
      title: CARD_TITLE,
      status: 'active',
      projectId: PROJECT_ID,
      links: [{ id: 'l1', label: 'PR', url: 'https://example.test/pr/1' }],
      slots: { dev: { sessionId: session.id } },
      createdAt: now,
      updatedAt: now,
    }],
  }, null, 2)}\n`)
}

test('英文链接编辑器：非法 URL 显示英文校验错误', { timeout: scenarioTimeout() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-i18n-link-'))
  const mock = await startMockProvider({})
  const problems = []
  let browser = null
  let instance = null
  t.after(() => stopScenario({ browser, instance, mock, root }))

  const first = await startInstanceIn({ root, baseUrl: mock.url })
  browser = await chromium.launch()
  const bootstrap = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
  const bootstrapPage = await bootstrap.newPage()
  watchProblems(bootstrapPage, problems)
  await bootstrapPage.goto(first.url, { waitUntil: 'domcontentloaded' })
  await waitForLocator(bootstrapPage.locator('div[role="textbox"][contenteditable="true"]').first(), {
    description: '第一段实例的输入框可编辑', timeoutMs: 20_000,
  })
  const session = await waitFor({ description: '宿主启动后落盘一个空会话', check: () => firstSession(first.home), timeoutMs: 5_000 })
  await bootstrap.close()
  await first.stop({ keepRoot: true })
  seedProject(first.home, session)
  seedCard(first.home, session)

  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watchProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })
  try { await page.getByRole('button', { name: 'Continue', exact: true }).first().click({ timeout: 4000 }) } catch { /* 没弹窗 */ }

  const projectRow = page.locator('.dsh-leader-agent-project-row').first()
  await waitForLocator(projectRow, { description: '项目行', timeoutMs: 20_000 })
  await waitFor({
    description: '项目可打开',
    check: async () => (await projectRow.getAttribute('data-dead')) === null,
    timeoutMs: 20_000,
  })
  await projectRow.click()
  await waitForLocator(page.locator('[data-sidebar-right-expand="true"]').first(), { description: '右栏展开按钮', timeoutMs: 15_000 })
  await page.locator('[data-sidebar-right-expand="true"]').first().click({ force: true })
  await waitFor({
    description: '右栏绑定到 leader 会话',
    check: async () => {
      const rightbar = page.locator('[data-sidebar-right-session]').first()
      return (await rightbar.getAttribute('data-sidebar-right-session').catch(() => null)) === session.id
    },
    timeoutMs: 15_000,
  })
  const guideEntry = page.locator('.dsh-leader-agent-guide-entry[data-sidebar-right-guide-entry="dsh-leader-agent-board"]')
  await waitForLocator(guideEntry, { description: '看板入口', timeoutMs: 15_000 })
  await guideEntry.click()

  const card = page.locator('.dsh-leader-agent-board-card').filter({ hasText: CARD_TITLE }).first()
  await waitForLocator(card, { description: '卡片出现', timeoutMs: 15_000 })
  await card.click()
  const detail = page.locator('.dsh-leader-agent-card-detail')
  await waitForLocator(detail, { description: '卡片详情打开', timeoutMs: 10_000 })
  await detail.getByRole('button', { name: en['card.detail.editLinks'], exact: true }).click()

  const url = page.locator('.dsh-leader-agent-link-editor-url').first()
  await waitForLocator(url, { description: '链接 URL 输入框', timeoutMs: 10_000 })
  await url.fill('javascript:alert(1)')
  await page.locator('.dsh-leader-agent-link-editor-button-primary').click()

  const error = page.locator('.dsh-leader-agent-link-editor-error')
  await waitForLocator(error, { description: '链接校验错误', timeoutMs: 10_000 })
  const text = (await error.innerText()).trim()
  assert.equal(text, en['card.links.error.invalidUrl'].replace('{label}', 'PR'))
  assert.equal(CJK.test(text), false, `链接校验错误出现中文：${text}`)

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
  await closeBrowser(browser)
  browser = null
})
