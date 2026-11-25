/**
 * 主面板被左栏面板页接管时，项目区块不能再亮着「当前会话」。
 *
 * 两种侧栏形态都要守：宽侧栏是项目行与会话行的选中态，窄导轨是入口图标 + 浮层
 * （固定定位，导航走了不收起就盖在主区域上）。
 *
 * 宿主的会话树用 `layout.panelInfo.activePanelId` 判这件事：面板页打开时
 * `current` 取 undefined，左栏的行一律不选中（`WorkspaceBrowser` 的
 * `panelActive` 分支）。项目区块早先只认会话快照里的主视图会话，点「插件」之后
 * 主区域已经换成插件页，项目行与它的会话行却还铺着选中底色——用户看到的是
 * 「点了两样东西，亮着的还是上一个」。
 *
 * 断言落在项目行自己的 `data-selected` 与 `aria-current`：选中态是行为，底色、
 * 高亮等样式不写进 e2e。
 *
 * 夹具与 project-workspace 同款：项目注册表只在宿主启动时读回内存
 * （`projects/service.js` 的 `loadIndex()`），所以先起一轮拿宿主建出的会话，停机
 * 写 `projects.json`，再起第二轮。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
      id: 'e2e-panel-selection-project',
      name: 'selection',
      directory: session.cwd,
      leaderSessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

/** 读项目行的选中态。 */
function readSelection(row) {
  return row.evaluate((node) => ({
    selected: node.getAttribute('data-selected'),
    ariaCurrent: node.getAttribute('aria-current'),
    // 主区域有没有会话：点行之前宿主自己的启动导航可能还没落定，没落定时
    // 点击会与它抢主视图，看起来像「点了没反应」。
    composer: document.querySelector('div[role="textbox"][contenteditable="true"]') !== null,
    guideCard: document.querySelectorAll('.dsh-leader-agent-guide-card').length,
  }))
}

test('打开左栏面板页后，项目区块与窄导轨浮层都不再保持选中态', { timeout: scenarioTimeout() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-panel-selection-'))
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
  const session = await waitFor({
    description: '宿主启动后落盘一个空会话',
    check: () => firstSession(first.home),
    timeoutMs: 5_000,
  })
  await bootstrap.close()
  await first.stop({ keepRoot: true })

  seedProject(first.home, session)

  // 第二段：同一个数据根，项目注册表在启动时读回内存。
  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watchProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })

  const row = page.locator('.dsh-leader-agent-project-row').first()
  // 先等区块被搬进左栏落点容器：portal 生效前它还在 footer 锚点里，此时点行，
  // 元素会在 mousedown 与 mouseup 之间被搬走，点击落空。
  await waitForLocator(page.locator('[data-dsh-leader-agent-projects] .dsh-leader-agent-project-row').first(), {
    description: '项目区块搬进左栏落点',
    timeoutMs: 20_000,
  })
  // 等宿主自己的启动导航落定（输入框出现 = 主区域已有会话）。不等就点项目行，
  // 宿主的首次打开可能随后把主视图换走，看起来像「点了没反应」。
  await waitForLocator(page.locator('div[role="textbox"][contenteditable="true"]').first(), {
    description: '宿主启动导航落定（输入框可编辑）',
    timeoutMs: 20_000,
  })
  await row.click()

  // 前置：点项目行打开 leader 后，这一行必须亮着。不先证明这一点，后面的「不亮」
  // 可能只是从来没亮过。
  await waitFor({
    description: '项目行进入选中态',
    check: async () => (await readSelection(row)).selected === 'true',
    timeoutMs: 15_000,
  }).catch(async (error) => {
    throw new Error(`${error.message}；失败读数 ${JSON.stringify(await readSelection(row))}`)
  })

  // 点左栏面板列表里的「插件」：主区域换成插件页，宿主会话树此时不再选中任何行。
  const pluginsRow = page.locator('nav button[aria-label="插件"]').first()
  await waitForLocator(pluginsRow, { description: '左栏出现「插件」面板行', timeoutMs: 15_000 })
  await pluginsRow.click()
  await waitForLocator(page.locator('nav button[aria-label="插件"][aria-current="page"]'), {
    description: '「插件」面板页接管主区域',
    timeoutMs: 15_000,
  })

  // 项目区块跟着宿主的会话树收敛：没有当前会话，就没有选中行。
  const after = await waitFor({
    description: '面板页打开后项目行退出选中态',
    check: async () => {
      const reading = await readSelection(row)
      return reading.selected === null ? reading : null
    },
    timeoutMs: 10_000,
  }).catch(async (error) => {
    throw new Error(`${error.message}；失败读数 ${JSON.stringify(await readSelection(row))}`)
  })
  assert.equal(after.ariaCurrent, null, `选中行不应再带 aria-current；读数 ${JSON.stringify(after)}`)

  // 窄导轨（56px）是同一件事的另一个形态：入口图标 + 固定定位的浮层。主区域被
  // 面板页接管后，浮层不能继续盖在插件页上、入口也不能还亮着。
  //
  // 先点回项目行：打开会话会同时关掉面板页，导轨才有「当前会话」可亮。
  await row.click()
  await waitFor({
    description: '点项目行回到 leader 后项目行重新选中',
    check: async () => (await readSelection(row)).selected === 'true',
    timeoutMs: 15_000,
  })
  await page.locator('button[aria-label="收起侧边栏"]').click()
  const entry = page.locator('button[title="项目"]').first()
  await waitForLocator(entry, { description: '窄导轨出现项目入口', timeoutMs: 15_000 })
  assert.equal(
    await page.locator('.dsh-leader-agent-project-section').count(),
    0,
    '导轨收起时项目浮层不应展开',
  )
  assert.equal(await entry.getAttribute('aria-expanded'), 'false', '浮层收起时入口的 aria-expanded 应为 false')
  await entry.click()
  await waitForLocator(page.locator('.dsh-leader-agent-project-section').first(), {
    description: '导轨里的项目浮层展开',
    timeoutMs: 10_000,
  })
  assert.equal(await entry.getAttribute('aria-expanded'), 'true', '浮层展开时入口的 aria-expanded 应为 true')

  const railPluginsRow = page.locator('nav button[aria-label="插件"]').first()
  await waitForLocator(railPluginsRow, { description: '导轨里出现「插件」入口', timeoutMs: 15_000 })
  await railPluginsRow.click()
  await waitForLocator(page.locator('nav button[aria-label="插件"][aria-current="page"]'), {
    description: '导轨里点「插件」后插件页接管主区域',
    timeoutMs: 15_000,
  })
  await waitFor({
    description: '面板页打开后导轨里的项目浮层收起',
    check: async () => (await page.locator('.dsh-leader-agent-project-section').count()) === 0,
    timeoutMs: 10_000,
  }).catch(async (error) => {
    const reading = { sections: await page.locator('.dsh-leader-agent-project-section').count() }
    throw new Error(`${error.message}；失败读数 ${JSON.stringify(reading)}`)
  })
  assert.equal(await entry.getAttribute('aria-expanded'), 'false', '浮层收起后入口的 aria-expanded 应为 false')

  // 在面板页上手动打开浮层，再切到另一个面板页：`panelActive` 的 boolean 没有翻转，
  // effect 若只依赖它会漏掉这次切换，浮层就继续盖在新面板页上。
  await entry.click()
  await waitForLocator(page.locator('.dsh-leader-agent-project-section').first(), {
    description: '插件页上手动展开项目浮层',
    timeoutMs: 10_000,
  })
  assert.equal(await entry.getAttribute('aria-expanded'), 'true', '浮层展开时入口的 aria-expanded 应为 true')
  const sectionsBeforeSwitch = await page.locator('.dsh-leader-agent-project-section').count()

  const railAutomationsRow = page.locator('nav button[aria-label="自动化任务"]').first()
  await waitForLocator(railAutomationsRow, { description: '导轨里出现「自动化任务」入口', timeoutMs: 15_000 })
  await railAutomationsRow.click()
  await waitForLocator(page.locator('nav button[aria-label="自动化任务"][aria-current="page"]'), {
    description: '「自动化任务」面板页接管主区域',
    timeoutMs: 15_000,
  })
  await waitFor({
    description: '面板页之间切换后导轨里的项目浮层收起',
    check: async () => (await page.locator('.dsh-leader-agent-project-section').count()) === 0,
    timeoutMs: 10_000,
  }).catch(async (error) => {
    const reading = {
      sectionsBeforeSwitch,
      sectionsAfterSwitch: await page.locator('.dsh-leader-agent-project-section').count(),
      ariaExpanded: await entry.getAttribute('aria-expanded'),
    }
    throw new Error(`${error.message}；失败读数 ${JSON.stringify(reading)}`)
  })
  console.log(`[e2e] 面板页切换前后 sections ${sectionsBeforeSwitch} -> 0`)
  assert.equal(await entry.getAttribute('aria-expanded'), 'false', '切换面板页后入口的 aria-expanded 应为 false')

  await e2eShot(page, 'panel-selection')
  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})

/**
 * 存一张截图：断言失败时它解释「当时界面上是什么样」。
 *
 * @param {import('playwright').Page} page - 页面
 * @param {string} label - 文件名（不含扩展名）
 * @returns {Promise<void>} 完成
 */
async function e2eShot(page, label) {
  const dir = join(WORKTREE, '.dev', 'e2e-artifacts', `panel-selection-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${label}.png`)
  await page.screenshot({ path: file })
  console.log(`[e2e] 截图 ${file}`)
}
