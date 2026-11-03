/**
 * 删掉工作区后，它的会话落进「未分组」，组头不能被一起藏掉。
 *
 * 两个前提一起守：
 * 1. 宿主删工作区只删注册，会话记录保留——它们应出现在「未分组」里；
 * 2. 宿主把未分组的组头与会话行渲染在两个不同的 `groupSection` 里（组头那个
 *    section 只有组头一个子元素）。早先按「组头的父 section 里有没有可见会话行」
 *    判空，永远为空，于是无条件藏掉组头——用户看到的就是「未分组整组消失」。
 *
 * 造状态走界面自己要走的动作（删工作区），不手改落盘文件：手改 `sessionIds`
 * 并不能让宿主把会话渲染成 stray 行，那种前提下断言什么都是空的。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { startInstanceIn } from './instance.mjs'
import { waitFor } from './harness.mjs'

const ROW_SELECTOR = '[data-row-key^="session:"]'

test('删掉工作区后，会话落进未分组且组头不被藏', { timeout: 180_000 }, async (t) => {
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

  const workspaceRow = page.locator('[data-row-key^="workspace:"]').first()
  await workspaceRow.waitFor({ state: 'visible', timeout: 60_000 })
  const workspaceKey = await workspaceRow.getAttribute('data-row-key')
  assert.notEqual(workspaceKey, 'workspace:', '删之前要先有一个真工作区')

  // 删工作区：注册没了，会话与落盘记录都还在。
  await workspaceRow.hover()
  await workspaceRow.locator('button[aria-label*="操作"]').first().click({ force: true })
  const removeItem = page.locator('[role="menuitem"]').filter({ hasText: '删除工作区' }).first()
  await removeItem.waitFor({ state: 'visible', timeout: 15_000 })
  await removeItem.click()
  const confirm = page.locator('button').filter({ hasText: '删除工作区' }).last()
  await confirm.click()

  // 工作区组头消失，会话换到「未分组」下。
  await waitFor({
    description: '真工作区的组头消失',
    check: async () => (await page.locator(`[data-row-key="${workspaceKey}"]`).count()) === 0,
    timeoutMs: 30_000,
  })
  const header = page.locator('[data-row-key="workspace:"]').first()
  await header.waitFor({ state: 'attached', timeout: 15_000 })

  const rows = await page.locator(ROW_SELECTOR).count()
  assert.ok(rows > 0, '删工作区不该带走会话行')

  const headerState = await header.evaluate((node) => ({
    classes: node.className,
    display: getComputedStyle(node).display,
  }))
  assert.equal(
    headerState.classes.includes('dsh-leader-kit-empty-ungrouped'),
    false,
    '组里还有会话时不能把「未分组」组头藏掉',
  )
  assert.notEqual(headerState.display, 'none', '「未分组」组头要可见')

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
