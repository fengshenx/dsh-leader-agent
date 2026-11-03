/**
 * 「未分组」组的显隐，两条路径各一条用例。
 *
 * 1. 删 dsh 工作区：注册没了、会话还在，它们要落进未分组且组头不被藏。这条路径在
 *    rc.2 的默认视图下**旧实现也不会藏组头**（组头与会话行在同一个 `groupSection`
 *    里，判空看到的是有行），所以它守的是「删工作区别把会话一起带走」，不是组头
 *    判据的回归用例。
 * 2. 删项目目录：项目会话（leader）不再能被项目树打开，就不该继续从官方树里排除；
 *    旧实现在目录失效后照样排除，未分组里只剩被隐藏的行 → 组头与行一起消失，这就是
 *    用户报障的形态。这条是 `directoryUsable` 那条修复的回归用例。
 *
 * 造状态走界面自己要走的动作（删工作区、删目录），不手改落盘文件。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { startInstanceIn } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { readSessionLogs } from './session-logs.mjs'
import { waitFor, waitForLocator } from './harness.mjs'


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

  // 删工作区：注册没了，会话与落盘记录都还在，它们换到「未分组」下。
  await removeWorkspace(page)
  const header = page.locator('[data-row-key="workspace:"]').first()
  await waitForLocator(header, { description: '未分组的组头', state: 'attached' })

  // 只数「未分组这一组」里的行：全树行数在别的组有会话时恒真，证明不了这一组
  const sectionRows = await header.evaluate((node) => {
    const section = node.parentElement
    const rows = [...section.querySelectorAll('[data-row-key^="session:"]')]
    return rows.filter((row) => getComputedStyle(row).display !== 'none').length
  })
  assert.ok(sectionRows > 0, '删工作区后，未分组这一组里要能看到会话行')

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

/** 走界面删掉真工作区，让它的会话落进「未分组」；返回被删组头的 key。 */
async function removeWorkspace(page) {
  const workspaceRow = page.locator('[data-row-key^="workspace:"]').first()
  await waitForLocator(workspaceRow, { description: '真工作区的行', timeoutMs: 20_000 })
  const workspaceKey = await workspaceRow.getAttribute('data-row-key')
  assert.notEqual(workspaceKey, 'workspace:', '删之前要先有一个真工作区')
  await workspaceRow.hover()
  await workspaceRow.locator('button[aria-label*="操作"]').first().click({ force: true })
  const removeItem = page.locator('[role="menuitem"]').filter({ hasText: '删除工作区' }).first()
  await waitForLocator(removeItem, { description: '工作区菜单里的「删除工作区」' })
  await removeItem.click()
  await page.locator('button').filter({ hasText: '删除工作区' }).last().click()
  await waitFor({
    description: '真工作区的组头消失',
    check: async () => (await page.locator(`[data-row-key="${workspaceKey}"]`).count()) === 0,
    timeoutMs: 30_000,
  })
  return workspaceKey
}

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

/** 把一个会话登记成项目，目录用给定的路径。 */
function seedProject(home, { id, directory }) {
  mkdirSync(join(home, 'dsh-leader-kit'), { recursive: true })
  writeFileSync(join(home, 'dsh-leader-kit', 'projects.json'), `${JSON.stringify({
    version: 1,
    projects: [{
      id: 'e2e-gone-directory-project',
      name: 'gone',
      directory,
      leaderSessionId: id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

test('项目目录被删后，项目会话不再被排除，「未分组」组头恢复', { timeout: 180_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-kit-e2e-gone-'))
  const directory = mkdtempSync(join(tmpdir(), 'dsh-leader-kit-e2e-gone-project-'))
  const mock = await startMockProvider({})
  const problems = []
  let browser = null
  let instance = null

  t.after(async () => {
    await browser?.close().catch(() => {})
    await instance?.stop().catch(() => {})
    await mock.stop().catch(() => {})
    rmSync(root, { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  })

  instance = await startInstanceIn({ root, baseUrl: mock.url })
  browser = await chromium.launch()
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })
  await page.goto(instance.url, { waitUntil: 'domcontentloaded' })
  await waitForLocator(page.locator('div[role="textbox"][contenteditable="true"]').first(), {
    description: '输入框就绪',
    timeoutMs: 20_000,
  })

  // 先删工作区，把会话赶进「未分组」——这一步之后才有那个组头。
  await removeWorkspace(page)

  // 把这个松散会话登记成以临时目录为家的项目：下一次 refresh 就会排除它。
  const session = firstSession(instance.home)
  assert.notEqual(session, null, '宿主启动后应有一个落盘的空会话')
  seedProject(instance.home, { id: session.id, directory })

  const header = page.locator('[data-row-key="workspace:"]').first()
  await waitForLocator(header, { description: '未分组的组头', state: 'attached' })
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
  })

  // 目录还在：这个会话被项目树认领，官方树里排除它，未分组组头随之藏起。
  await waitFor({
    description: '目录还在时项目会话被排除，未分组组头藏起来',
    check: async () => header.evaluate((node) => node.classList.contains('dsh-leader-kit-empty-ungrouped')),
    timeoutMs: 30_000,
  })

  // 删目录：项目行再也打不开、项目树也没有 leader 行，继续排除会让会话两处都不可达。
  rmSync(directory, { recursive: true, force: true })
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
  })

  await waitFor({
    description: '删目录后未分组组头恢复可见',
    check: async () => header.evaluate((node) => !node.classList.contains('dsh-leader-kit-empty-ungrouped')),
    timeoutMs: 30_000,
  })

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
