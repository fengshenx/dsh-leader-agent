/**
 * 项目目录失效后，项目会话不再被渲染层排除。
 *
 * 项目记录不随目录消失：目录删掉后项目行打不开（打开前本仓自己会拦），项目树也
 * 没有 leader 的行。渲染层若继续把该项目的会话从官方工作区树里排除，那些会话在
 * 两棵树里都不可达——用户看到的就是「会话消失，卸载插件才回来」。
 *
 * 造状态走界面自己要走的动作（发一条消息、删工作区）加登记项目记录，不手改会话
 * 落盘。断言落在官方树里那一行的计算样式与项目行的失效标记上。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { startInstanceIn } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { waitFor, waitForLocator } from './harness.mjs'

/** 场景标记：mock 用它选脚本。 */
const MARKER = 'MOCK-E2E-DIR-GONE'
const REPLY = 'mock 回执已收到'
/** mock 给会话起标题时的固定回执，用来在左栏定位那一行。 */
const SESSION_TITLE = 'e2e 会话'
const EXCLUDED_CLASS = 'dsh-leader-kit-excluded-session'
const UNGROUPED_HIDDEN_CLASS = 'dsh-leader-kit-empty-ungrouped'

test('项目目录被删后，它的会话回到官方树里可见', { timeout: 300_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-kit-e2e-dir-gone-'))
  const directory = mkdtempSync(join(tmpdir(), 'dsh-leader-kit-e2e-dir-gone-project-'))
  const mock = await startMockProvider({ scripts: { [MARKER]: [{ text: REPLY }] } })
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

  // 发一条消息：会话因此非空，宿主才会在树里渲染它的行（空会话只留当前那个）。
  const composer = page.locator('div[role="textbox"][contenteditable="true"]').first()
  await waitForLocator(composer, { description: '输入框可编辑', timeoutMs: 20_000 })
  await composer.click()
  await composer.fill(`${MARKER} 收工即可`)
  await composer.press('Enter')
  await waitForLocator(page.getByText(REPLY).first(), { description: 'mock 回复上屏', timeoutMs: 30_000 })

  const sessionRow = page.locator(`[data-row-key^="session:"]`).filter({ hasText: SESSION_TITLE }).first()
  await waitForLocator(sessionRow, { description: '会话行出现在左栏', timeoutMs: 20_000 })
  const sessionKey = await sessionRow.getAttribute('data-row-key')
  const sessionId = sessionKey.replace(/^session:/, '')

  // 删工作区：会话落进「未分组」，那时它在官方树里可见。
  await removeWorkspace(page)
  await waitFor({
    description: '删工作区后会话行仍在树里',
    check: async () => (await sessionRow.count()) === 1,
    timeoutMs: 30_000,
  })

  // 把这个会话登记成以临时目录为家的项目：项目 leader 会被排除出官方树。
  seedProject(instance.home, { id: sessionId, directory })
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
  })

  await waitFor({
    description: '目录还在时项目会话被排除',
    check: async () => sessionRow.evaluate((node, cls) => node.classList.contains(cls), EXCLUDED_CLASS),
    timeoutMs: 30_000,
  })
  // 项目行的 `data-dead` 只看 leader 是否存活（`isProjectOpenable`），与目录态无关，
  // 拿它断言目录等于恒真；这里只等行渲染出来，删目录后再断言它没消失。
  const projectRow = page.locator('.dsh-leader-kit-project-row').first()
  await waitForLocator(projectRow, { description: '项目行出现在左栏', timeoutMs: 20_000 })

  // 删目录：项目行再也打不开，继续排除会让会话两处都不可达。
  // 不派发 focus：真实场景里用户在别处删目录，窗口不会收到任何事件，
  // 客户端只能靠自己重新问一次宿主。
  rmSync(directory, { recursive: true, force: true })

  await waitFor({
    description: '删目录后会话行回到官方树里可见',
    check: async () => sessionRow.evaluate(
      (node, cls) => !node.classList.contains(cls) && getComputedStyle(node).display !== 'none',
      EXCLUDED_CLASS,
    ),
    timeoutMs: 30_000,
  })

  // 组头跟着行一起恢复：main 的判据是「组里没有可见行才藏」。
  const header = page.locator('[data-row-key="workspace:"]').first()
  await waitForLocator(header, { description: '未分组的组头', state: 'attached', timeoutMs: 20_000 })
  assert.equal(
    await header.evaluate((node, cls) => node.classList.contains(cls), UNGROUPED_HIDDEN_CLASS),
    false,
    '组里已经有可见会话，不能把「未分组」组头藏掉',
  )
  assert.equal(await projectRow.count(), 1, '项目记录还在：项目行不该跟目录一起消失')

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})

/** 走界面删掉真工作区，让它的会话落进「未分组」。 */
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
