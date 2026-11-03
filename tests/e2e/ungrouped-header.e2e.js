/**
 * 「未分组」里还有会话时，组头不能被插件藏掉。
 *
 * 早先的判据按 DOM 判空：从组头往上找分组容器、数容器里的会话行。它押在「组头所在
 * 容器里能查到自己的行」上——宿主怎么分层、折叠时渲染几行都能影响这个查询，一旦落空
 * 就当成「组是空的」，组头被无条件藏掉，用户看到未分组整组消失、卸载插件才回来。
 * 判据改成会话快照后与宿主排版无关。
 *
 * 造状态走界面自己的动作（删工作区），不手改落盘文件：手改 `sessionIds` 并不能让
 * 宿主把会话渲染成松散行。断言落在计算样式与类名上，不读任何自述文本。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { startInstanceIn } from './instance.mjs'
import { waitFor, waitForLocator } from './harness.mjs'

const ROW_SELECTOR = '[data-row-key^="session:"]'
const EMPTY_UNGROUPED_CLASS = 'dsh-leader-kit-empty-ungrouped'

test('删掉工作区后，未分组里的会话与组头都得在', { timeout: 180_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-kit-e2e-ungrouped-'))
  const problems = []
  let browser = null
  let instance = null

  t.after(async () => {
    await browser?.close().catch(() => {})
    await instance?.stop().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  })

  instance = await startInstanceIn({ root })
  browser = await chromium.launch()
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })
  await page.goto(instance.url, { waitUntil: 'domcontentloaded' })

  // 删工作区：只删注册，会话记录保留，它们落进「未分组」。
  const workspaceRow = page.locator('[data-row-key^="workspace:"]').first()
  await waitForLocator(workspaceRow, { description: '真工作区的行', timeoutMs: 30_000 })
  const workspaceKey = await workspaceRow.getAttribute('data-row-key')
  assert.notEqual(workspaceKey, 'workspace:', '删之前要先有一个真工作区')
  await workspaceRow.hover()
  await workspaceRow.locator('button[aria-label*="操作"]').first().click({ force: true })
  const removeItem = page.locator('[role="menuitem"]').filter({ hasText: '删除工作区' }).first()
  await waitForLocator(removeItem, { description: '菜单里的「删除工作区」', timeoutMs: 15_000 })
  await removeItem.click()
  await page.locator('button').filter({ hasText: '删除工作区' }).last().click()
  await waitFor({
    description: '真工作区的组头消失',
    check: async () => (await page.locator(`[data-row-key="${workspaceKey}"]`).count()) === 0,
    timeoutMs: 30_000,
  })

  // 会话行还在，只是换了分组。
  await waitFor({
    description: '未分组里渲染出会话行',
    check: async () => (await page.locator(ROW_SELECTOR).count()) > 0,
    timeoutMs: 20_000,
  })

  // 组头不能跟着消失：这是本次回归的判据。
  const header = page.locator('[data-row-key="workspace:"]').first()
  await waitForLocator(header, { description: '未分组的组头', state: 'attached', timeoutMs: 20_000 })
  const state = await header.evaluate((node) => ({
    classes: node.className,
    display: getComputedStyle(node).display,
  }))
  assert.equal(
    state.classes.includes(EMPTY_UNGROUPED_CLASS),
    false,
    '未分组里还有会话时不能给组头加隐藏类',
  )
  assert.notEqual(state.display, 'none', '未分组组头要真的显示出来')

  const rows = await page.locator(ROW_SELECTOR).evaluateAll((nodes) => nodes.map((node) => ({
    display: getComputedStyle(node).display,
  })))
  assert.ok(
    rows.some((row) => row.display !== 'none'),
    '未分组里的会话行要可见',
  )

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
