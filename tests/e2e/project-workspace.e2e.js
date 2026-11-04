/**
 * 项目与 dsh 工作区解耦：leader 不归属任何工作区，历史挂载在启动时摘掉。
 *
 * 宿主把「工作区里第一个空白会话」当作可复用的新建草稿（`ui-workspace` 的
 * `createInWorkspace`），而 leader 恰好一直空着——旧版本把 leader 挂进项目目录的
 * 工作区后，用户在工作区里新建会话会直接打开 leader。这条场景守两件事：新数据不
 * 再挂接，以及旧数据在启动迁移里被摘干净。
 *
 * 断言落在落盘（`storages/workspace.json`）与插件自己的 DOM 上，不读宿主的内部状态。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { WORKTREE, startInstanceIn } from './instance.mjs'
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
      id: 'e2e-workspace-project',
      name: 'decouple',
      directory: session.cwd,
      leaderSessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

/**
 * 把 leader 塞回默认工作区，模拟旧版本留下的挂载。
 *
 * @param {string} home - 实例数据根
 * @param {string} sessionId - leader 会话 id
 * @returns {string} 被写入的工作区 id
 */
function seedLegacyAttachment(home, sessionId) {
  const file = join(home, 'storages', 'workspace.json')
  const store = JSON.parse(readFileSync(file, 'utf8'))
  const workspaces = Object.values(store.tables.workspaces)
  const workspace = workspaces[0]
  if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.unshift(sessionId)
  writeFileSync(file, JSON.stringify(store))
  return workspace.id ?? Object.keys(store.tables.workspaces)[0]
}

/** 读工作区注册表里的挂载情况。 */
function attachmentOf(home, workspaceId, sessionId) {
  const store = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
  return (store.tables.workspaces[workspaceId]?.sessionIds ?? []).includes(sessionId)
}

test('项目会话不归属工作区，历史挂载在启动时摘掉', { timeout: scenarioTimeout() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-decouple-'))
  const mock = await startMockProvider({})
  const problems = []
  let browser = null
  let instance = null

  t.after(() => stopScenario({ browser, instance, mock, root }))

  // 第一段：让宿主建出它的空会话，拿到 id 与 cwd。
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
  // 建会话是宿主的异步动作：输入框可编辑不代表日志已经落盘，等到出现再取 id。
  const session = await waitFor({
    description: '宿主启动后落盘一个空会话',
    check: () => firstSession(first.home),
    timeoutMs: 5_000,
  })
  await bootstrap.close()
  await first.stop({ keepRoot: true })

  seedProject(first.home, session)
  const workspaceId = seedLegacyAttachment(first.home, session.id)
  assert.equal(attachmentOf(first.home, workspaceId, session.id), true, '前置：旧挂载已写入')

  // 第二段：同一个数据根，启动迁移应把 leader 从工作区摘掉。
  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second

  await waitFor({
    description: '启动迁移把 leader 从工作区里摘掉',
    check: () => attachmentOf(second.home, workspaceId, session.id) === false,
    timeoutMs: 20_000,
  })

  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watchProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })

  const row = page.locator('.dsh-leader-agent-project-row').first()
  await waitForLocator(row, { description: '项目行出现在左栏', timeoutMs: 20_000 })
  await row.click()

  // 点项目行仍然能打开 leader：不归属工作区不影响可打开性。
  await waitForLocator(page.locator('.dsh-leader-agent-guide-card'), {
    description: '打开 leader 后引导卡出现',
    timeoutMs: 15_000,
  })
  // 未分组组里只剩被排除的项目会话时，组头也要一起消失：宿主为 stray 会话渲染了
  // 「未分组」组头，而组内的行全被渲染层隐藏了。
  const ungrouped = page.locator('[data-row-key="workspace:"]')
  await waitForLocator(ungrouped.first(), { description: '未分组组头出现', state: 'attached', timeoutMs: 15_000 })
  assert.equal(
    await ungrouped.first().evaluate((node) => node.classList.contains('dsh-leader-agent-empty-ungrouped')),
    true,
    '未分组里只剩被排除的项目会话时，组头也要藏起来',
  )

  // 在工作区里新建会话：leader 已不在工作区，宿主的空白草稿复用找不到它。
  const workspaceRow = page.locator('[data-row-key^="workspace:"]').filter({ hasText: '默认工作区' }).first()
  await waitForLocator(workspaceRow, { description: '默认工作区行出现', timeoutMs: 20_000 })
  await workspaceRow.hover()
  await workspaceRow.locator('button[aria-label*="新建会话"]').first().click({ force: true })
  await waitForLocator(page.locator('.dsh-leader-agent-guide-card'), {
    description: '新建会话后引导卡消失',
    state: 'detached',
    timeoutMs: 20_000,
  })

  // 界面停在新建出来的会话上，而不是被复用的 leader。
  const currentSessionId = await page.evaluate(() => {
    // 宿主会话行用 role="treeitem" + aria-selected 标当前行（`Rows.tsx` 的
    // `aria-selected={selected}`）；`.selected` 是 CSS Modules 哈希类名，靠不住。
    const row = document.querySelector('[data-row-key^="session:"][aria-selected="true"]')
    return row?.getAttribute('data-row-key') ?? null
  })
  assert.equal(typeof currentSessionId, 'string', '应当能读到当前会话行（aria-selected="true"）')
  assert.notEqual(currentSessionId, `session:${session.id}`, '在工作区新建会话不应停在 leader 上')

  const artifacts = join(WORKTREE, '.dev', 'e2e-artifacts', `project-workspace-${process.pid}`)
  mkdirSync(artifacts, { recursive: true })
  await page.screenshot({ path: join(artifacts, 'decoupled.png') })
  console.log(`[e2e] 截图 ${join(artifacts, 'decoupled.png')}`)

  // 删项目只删记录：目录、会话与 dsh 工作区都留下，两个东西各归各的。
  const workspacesBefore = JSON.parse(readFileSync(join(second.home, 'storages', 'workspace.json'), 'utf8'))
  await row.hover()
  await row.locator('button[title="更多"]').click()
  await page.locator('.dsh-leader-agent-project-menu-item').filter({ hasText: '删除' }).click()
  await page.locator('.dsh-leader-agent-modal-button-danger').click()
  await waitForLocator(page.locator('.dsh-leader-agent-project-row').first(), {
    description: '删项目后项目行消失',
    state: 'detached',
    timeoutMs: 15_000,
  })
  const workspacesAfter = JSON.parse(readFileSync(join(second.home, 'storages', 'workspace.json'), 'utf8'))
  assert.deepEqual(workspacesAfter.tables.workspaces, workspacesBefore.tables.workspaces, '删项目不应改动 dsh 工作区')
  assert.equal(existsSync(session.cwd), true, '删项目不应删目录')
  assert.equal(
    readFileSync(join(second.home, 'dsh-leader-agent', 'projects.json'), 'utf8').includes('e2e-workspace-project'),
    false,
    '删项目应清掉项目记录',
  )

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
