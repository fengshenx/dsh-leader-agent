/**
 * leader 会话隐藏宿主的「已编辑 N 个文件」汇总卡片。
 *
 * 两段起实例（项目注册表只在启动时读回内存）：第一段等宿主落盘一个会话，停掉后
 * 把它登记成项目 leader；第二段从项目行打开 leader，切到完全权限后跑一轮真实的
 * 文件写入让宿主渲染改动文件卡片，断言卡片在 DOM 里但不可见；再新建普通会话跑
 * 同一形态的一轮，断言卡片可见、隐藏标记不落在它的主面板上。
 *
 * 断言落在外部可观察量上：卡片节点是否在 DOM、`isVisible()` 是否成立、主面板容器
 * 上有没有隐藏标记、写出的文件是否真的落盘。不读本插件自述，也不拿「卡片没渲染」
 * 冒充「隐藏生效」——先等卡片挂上再判可见性。
 *
 * 权限：会话默认预设是 workspace-write，未归属工作区的会话只被允许写平台临时
 * 目录，而宿主的改动记录恰好排除临时目录。场景在目标会话里用 `/permission` 切到
 * 完全权限，让写入落在会话工作区；权限只是搭场景的手段，隐藏逻辑只看会话身份。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { WORKTREE, startInstanceIn } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { scenarioTimeout, stopScenario, waitFor, waitForLocator, watchProblems } from './harness.mjs'

const MARKERS = {
  leader: 'MOCK-HIDE-LEADER',
  ordinary: 'MOCK-HIDE-ORDINARY',
}

const LEADER_REPLY = 'leader 场景：改动已经写进文件。'
const ORDINARY_REPLY = '普通会话场景：改动已经写进文件。'

/** 从数据根里取宿主启动时建的会话。 */
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

/** 首次打开宿主会弹「预览版说明」，不关掉会挡住输入框。 */
async function dismissWelcome(page) {
  const button = page.getByRole('dialog').getByRole('button', { name: '继续' })
  try { await button.click({ timeout: 4000 }) } catch { /* 没弹窗就继续 */ }
}

/** 读页面上当前被选中的宿主会话 id。 */
async function currentSessionId(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-row-key^="session:"][aria-selected="true"]')
    return row?.getAttribute('data-row-key')?.slice('session:'.length) ?? null
  })
}

/** 把当前会话切到完全权限；写入要先落进会话工作区，默认预设不允许。 */
async function enableFullAccess(page) {
  const composer = page.locator('div[role="textbox"][contenteditable="true"]').first()
  await waitForLocator(composer, { description: '权限切换前的输入框', timeoutMs: 20_000 })
  await composer.click()
  await composer.fill('/permission danger-full-access')
  await composer.press('Enter')
  await waitForLocator(page.locator('button[aria-label*="完全权限"]').first(), {
    description: '权限切到完全权限',
    timeoutMs: 15_000,
  })
}

/** 发一句话并等它上屏。 */
async function send(page, text, reply) {
  const composer = page.locator('div[role="textbox"][contenteditable="true"]').first()
  await waitForLocator(composer, { description: '输入框', timeoutMs: 20_000 })
  await composer.click()
  await composer.fill(text)
  await composer.press('Enter')
  await waitForLocator(page.getByText(reply).first(), { description: '回复上屏' })
}

/** 等改动文件卡片挂上，返回最后一张。 */
async function waitForChangedFiles(page) {
  const card = page.locator('[data-changed-files]').last()
  await waitForLocator(card, { description: '改动文件卡片', state: 'attached', timeoutMs: 25_000 })
  return card
}

/** 写项目注册表：第一段落盘的会话当 leader。 */
function seed(home, leader) {
  mkdirSync(join(home, 'dsh-leader-agent'), { recursive: true })
  const now = Date.now()
  writeFileSync(join(home, 'dsh-leader-agent', 'projects.json'), `${JSON.stringify({
    version: 1,
    projects: [{
      id: 'leader-changes-project',
      name: '改动卡片场景',
      directory: leader.cwd,
      leaderSessionId: leader.id,
      createdAt: now,
      updatedAt: now,
    }],
  }, null, 2)}\n`)
}

test('leader 会话隐藏宿主的改动文件卡片，普通会话保留', {
  timeout: scenarioTimeout(150_000),
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-leader-changes-'))
  const problems = []
  // 落点等第一段拿到会话 cwd 才定：宿主会排除平台临时目录，文件得写进会话工作区。
  const changedFiles = []
  const scripts = {}
  const mock = await startMockProvider({ scripts })
  let browser = null
  let instance = null

  t.after(() => {
    for (const file of changedFiles) rmSync(file, { force: true })
    return stopScenario({ browser, instance, mock, root })
  })

  // 第一段：起实例，等宿主落在盘上的第一个会话。
  const first = await startInstanceIn({ root, baseUrl: mock.url })
  instance = first
  browser = await chromium.launch()
  const bootstrapContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const bootstrap = await bootstrapContext.newPage()
  watchProblems(bootstrap, problems)
  await bootstrap.goto(first.url, { waitUntil: 'domcontentloaded' })
  await waitForLocator(bootstrap.locator('div[role="textbox"][contenteditable="true"]').first(), {
    description: '第一段输入框',
    timeoutMs: 20_000,
  })
  await dismissWelcome(bootstrap)
  const leader = await waitFor({
    description: '宿主启动后落盘一个会话',
    check: () => firstSession(first.home),
    timeoutMs: 5_000,
  })
  await bootstrapContext.close()
  await first.stop({ keepRoot: true })
  instance = null

  seed(first.home, leader)

  // 落点选工作树里被忽略的 `.dev`：e2e 的宿主进程跑在插件的沙箱里，本仓是它
  // 允许写的范围；宿主的改动记录又排除平台临时目录，所以不能写数据根（tmp）。
  const leaderFile = join(WORKTREE, '.dev', 'e2e-artifacts', 'leader-changes', 'leader-changed.txt')
  const ordinaryFile = join(WORKTREE, '.dev', 'e2e-artifacts', 'leader-changes', 'ordinary-changed.txt')
  mkdirSync(join(WORKTREE, '.dev', 'e2e-artifacts', 'leader-changes'), { recursive: true })
  changedFiles.push(leaderFile, ordinaryFile)
  scripts[MARKERS.leader] = [
    { tool: { name: 'write', input: { file_path: leaderFile, content: 'leader 改动\n' } } },
    { text: LEADER_REPLY },
  ]
  scripts[MARKERS.ordinary] = [
    { tool: { name: 'write', input: { file_path: ordinaryFile, content: '普通会话改动\n' } } },
    { text: ORDINARY_REPLY },
  ]

  // 第二段：项目行打开 leader，切权限后跑一轮写文件。
  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watchProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })
  await waitForLocator(page.locator('div[role="textbox"][contenteditable="true"]').first(), {
    description: '第二段输入框',
    timeoutMs: 20_000,
  })
  await dismissWelcome(page)

  const projectRow = page.locator('.dsh-leader-agent-project-row').first()
  await waitForLocator(projectRow, { description: '项目行', timeoutMs: 20_000 })
  await projectRow.click()
  await enableFullAccess(page)

  await send(page, `${MARKERS.leader} 把结论写进文件。`, LEADER_REPLY)
  await waitFor({
    description: 'write 真的落盘到会话工作区',
    check: () => existsSync(leaderFile),
    timeoutMs: 10_000,
  })
  const leaderCard = await waitForChangedFiles(page)

  // 卡片必须先挂上，再判隐藏——「没渲染」不能冒充「隐藏生效」。
  assert.equal(await page.locator('[data-changed-files]').count() >= 1, true, 'leader 会话应渲染改动文件卡片节点')
  assert.equal(await leaderCard.isVisible(), false, 'leader 会话的改动文件卡片应不可见')
  const markedPanels = page.locator('[data-dsh-leader-agent-hide-changed-files]')
  assert.equal(await markedPanels.count(), 1, 'leader 会话的主面板应带隐藏标记')
  const marker = await markedPanels.first().evaluate((element) => ({
    tag: element.tagName,
    className: typeof element.className === 'string' ? element.className : '',
    onMainPanel: element.matches('[class*="mainPanel"]'),
  }))
  assert.equal(
    marker.onMainPanel,
    true,
    `隐藏标记应落在 mainPanel 节点，而不是父 frame：${JSON.stringify(marker)}`,
  )

  // 隐藏用 display:none，浏览器不应把焦点放进不可见卡片；完整 Tab 序回归留待限制说明。
  const focusableInCard = leaderCard.locator('button, a').first()
  assert.ok(await focusableInCard.count() > 0, '改动文件卡片应有可聚焦节点')
  await focusableInCard.evaluate((element) => element.focus())
  assert.equal(
    await page.evaluate(() => document.activeElement?.closest('[data-changed-files]') !== null),
    false,
    '隐藏后焦点不应进入改动文件卡片',
  )

  // 降级探针：去掉宿主 mainPanel 类后标记必须摘掉、卡片恢复；恢复类后重新隐藏。
  const panels = await page.locator('[class*="mainPanel"]').elementHandles()
  assert.ok(panels.length > 0, '宿主应存在 mainPanel 节点')
  const removedClasses = await Promise.all(panels.map((panel) => panel.evaluate((element) => (
    Array.from(element.classList).filter((name) => name.includes('mainPanel'))
  ))))
  for (const panel of panels) {
    await panel.evaluate((element) => {
      for (const name of Array.from(element.classList)) {
        if (name.includes('mainPanel')) element.classList.remove(name)
      }
    })
  }
  await waitFor({
    description: '去掉 mainPanel 类后改动文件卡片恢复可见',
    check: () => leaderCard.isVisible(),
    timeoutMs: 4_000,
  })
  t.diagnostic(`去掉 mainPanel 类后可见：${await leaderCard.isVisible()}`)

  for (let index = 0; index < panels.length; index += 1) {
    await panels[index].evaluate((element, names) => {
      for (const name of names) element.classList.add(name)
    }, removedClasses[index])
  }
  await waitFor({
    description: '恢复 mainPanel 类后改动文件卡片再次隐藏',
    check: async () => !(await leaderCard.isVisible()),
    timeoutMs: 4_000,
  })
  t.diagnostic(`恢复 mainPanel 类后可见：${await leaderCard.isVisible()}`)

  const artifacts = join(WORKTREE, '.dev', 'e2e-artifacts', 'leader-changes')
  mkdirSync(artifacts, { recursive: true })
  await page.screenshot({ path: join(artifacts, 'leader-hidden.png') })

  // 普通会话：同一形态跑一轮，卡片可见、主面板不带隐藏标记。
  const workspaceRow = page.locator('[data-row-key^="workspace:"]').filter({ hasText: '默认工作区' }).first()
  await waitForLocator(workspaceRow, { description: '默认工作区行', timeoutMs: 20_000 })
  await workspaceRow.hover()
  await workspaceRow.locator('button[aria-label*="新建会话"]').first().click({ force: true })
  const ordinaryId = await waitFor({
    description: '普通会话成为当前会话',
    check: async () => {
      const now = await currentSessionId(page)
      return typeof now === 'string' && now !== leader.id ? now : null
    },
    timeoutMs: 20_000,
  })
  assert.notEqual(ordinaryId, leader.id, '普通会话不能是 leader 会话')

  await enableFullAccess(page)
  await send(page, `${MARKERS.ordinary} 把结论写进文件。`, ORDINARY_REPLY)
  await waitFor({
    description: '普通会话的 write 落盘',
    check: () => existsSync(ordinaryFile),
    timeoutMs: 10_000,
  })
  const ordinaryCard = await waitForChangedFiles(page)
  assert.equal(await ordinaryCard.isVisible(), true, '普通会话的改动文件卡片应保持可见')
  assert.equal(
    await page.locator('[data-dsh-leader-agent-hide-changed-files]').count(),
    0,
    '普通会话的主面板容器不应带隐藏标记',
  )
  await page.screenshot({ path: join(artifacts, 'ordinary-visible.png') })

  assert.deepEqual(problems, [])
})
