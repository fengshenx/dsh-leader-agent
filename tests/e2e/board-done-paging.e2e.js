/**
 * 右栏看板的「已完成」区按 30 张分页：默认一页，展开再加一页，展开完变「收起」。
 *
 * 这个场景守的是**接线**：纯函数 `foldDoneCards` / `nextDoneWatermark` 已有单测，
 * 但把 `doneFold.rows` 换回 `done`（等于关掉 UI 分页）时单测全绿——只有真实宿主
 * 里渲染出的行数能证明分页真的接上了。31 张 done 卡直接 seed 进卡片库，再从右栏
 * guide 页的「看板」入口打开面板：不依赖建卡后自动弹出看板的那条监视器通路，
 * 省掉「首轮基线」与「新卡」的时间竞态（那条通路由 `project-board-monitor.test.js`
 * 单测守着）。
 *
 * 断言落在插件自己的 DOM 与计算样式上：done 行数、「展开其余 / 收起」的文案与
 * `aria-expanded`、done 标题与卡号的计算字号。
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

/** 分页页大小：与 `src/client/board-projection.js` 的 `DONE_PAGE_SIZE` 对齐。 */
const PAGE_SIZE = 30
/** 多出的一页：31 张 = 一页 + 1，正好验证「展开其余 1 个卡片」。 */
const DONE_TOTAL = PAGE_SIZE + 1
const PROJECT_ID = 'e2e-board-paging-project'
const DONE_ROW = '.dsh-leader-agent-board-card-done'
const MORE_BUTTON = '.dsh-leader-agent-board-done-more'

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
      name: 'paging',
      directory: session.cwd,
      leaderSessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

/** 直接种 31 张 done 卡：看板按项目从卡片库取数，不需要经过建卡工具。 */
function seedDoneCards(home) {
  const now = Date.now()
  const cards = Array.from({ length: DONE_TOTAL }, (_, index) => ({
    id: `e2e-done-card-${index + 1}`,
    number: index + 1,
    revision: 1,
    title: `历史任务 ${index + 1}`,
    status: 'done',
    projectId: PROJECT_ID,
    createdAt: now - DONE_TOTAL * 1000 + index,
    updatedAt: now - DONE_TOTAL * 1000 + index,
    // done 区按 doneAt 倒序排，逐个错开保证这一页切出来的就是前 30 张。
    doneAt: now - DONE_TOTAL * 1000 + index,
  }))
  writeFileSync(join(home, 'dsh-leader-agent', 'cards.json'), `${JSON.stringify({
    version: 1,
    counter: DONE_TOTAL,
    cards,
  }, null, 2)}\n`)
}

/**
 * 读「已完成」区的一次完整读数。
 *
 * @param {import('playwright').Page} page - 页面
 * @returns {Promise<object>} 行数、按钮文案与状态、done 标题与卡号的计算字号
 */
async function readDoneSection(page) {
  return page.evaluate(({ rowSelector, moreSelector }) => {
    const more = document.querySelector(moreSelector)
    const title = document.querySelector('.dsh-leader-agent-board-done-title')
    const number = document.querySelector('.dsh-leader-agent-board-card-number')
    return {
      rows: document.querySelectorAll(rowSelector).length,
      moreText: more?.textContent ?? null,
      moreExpanded: more?.getAttribute('aria-expanded') ?? null,
      titleSize: title === null ? null : getComputedStyle(title).fontSize,
      numberSize: number === null ? null : getComputedStyle(number).fontSize,
    }
  }, { rowSelector: DONE_ROW, moreSelector: MORE_BUTTON })
}

test('已完成区默认 30 行，展开到 31 行变「收起」，收起回 30 行', { timeout: scenarioTimeout() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-board-paging-'))
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
  seedDoneCards(first.home)

  // 第二段：同一个数据根启动，项目与卡片在启动后就能读到。
  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watchProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })

  // 打开 leader 会话：看板入口只在项目会话（leader / worker）里渲染。
  const projectRow = page.locator('.dsh-leader-agent-project-row').first()
  await waitForLocator(projectRow, { description: '项目行出现在左栏', timeoutMs: 20_000 })
  // data-dead 表示宿主还没把 leader 会话算进存活集合。此时点开只会弹「leader 已被
  // 删除」，而面板下一轮刷新会把标记摘掉——先等它就绪，点击才一定会切主视图。
  await waitFor({
    description: '项目可打开（leader 会话已就绪）',
    check: async () => (await projectRow.getAttribute('data-dead')) === null,
    timeoutMs: 20_000,
  })
  await projectRow.click()
  // 点项目行是异步切主视图；切到 leader 之前展开右栏，guide 页可能还绑着上一个
  // 会话，入口要等会话切换完才渲染。data-selected 与右栏读的是同一个当前会话。
  try {
    await waitFor({
      description: '项目行进入选中态（当前会话已切到 leader）',
      check: async () => (await projectRow.getAttribute('data-selected')) === 'true',
      timeoutMs: 15_000,
    })
  } catch (error) {
    const state = await projectRow.evaluate((node) => ({
      dead: node.getAttribute('data-dead'),
      selected: node.getAttribute('data-selected'),
      current: node.getAttribute('aria-current'),
      title: node.getAttribute('title'),
    }))
    throw new Error(`${error.message}；项目行读数 ${JSON.stringify(state)}`, { cause: error })
  }

  // 展开右栏，从 guide 页的「看板」胶囊进面板。入口挂载后要问一次项目通道，
  // 所以等胶囊出现而不是固定等待。
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

  // 「已完成」默认收起；点开它才渲染分页后的行。
  const doneToggle = page.locator('.dsh-leader-agent-board-done-toggle')
  await waitForLocator(doneToggle, { description: '已完成区的折叠开关', timeoutMs: 15_000 })
  assert.equal((await doneToggle.innerText()).includes(String(DONE_TOTAL)), true, '已完成计数应是 31')
  await doneToggle.click()

  // 按钮只在「还有被藏起来的卡」或「已展开」时渲染；它出现即说明看板已经拿到
  // 31 张 done 卡并完成首帧。之后不再等某个具体行数——直接把实际行数读出来断言，
  // 分页没接线时失败信息里才有真实读数（只等 30 行会让读数退化成一句超时）。
  await waitForLocator(page.locator(MORE_BUTTON), { description: '「展开其余」按钮', timeoutMs: 10_000 })
  const folded = await readDoneSection(page)
  assert.equal(folded.rows, PAGE_SIZE, `默认应渲染 ${PAGE_SIZE} 行`)
  assert.equal(folded.moreText, '展开其余 1 个卡片')
  assert.equal(folded.moreExpanded, 'false')
  // 字号是本 PR 的另一半：done 标题与卡号同档（11px），展开前后都不变。
  assert.equal(folded.titleSize, '11px', 'done 标题字号应是 11px')
  assert.equal(folded.numberSize, '11px', '卡号字号应是 11px')
  assert.equal(folded.titleSize, folded.numberSize, 'done 标题与卡号应同字号')

  // 展开：一次把剩下的 1 张放完，按钮变「收起」。
  await page.locator(MORE_BUTTON).click()
  await waitFor({
    description: '「展开其余」按钮变成「收起」',
    check: async () => (await readDoneSection(page)).moreText === '收起',
    timeoutMs: 10_000,
  })
  const expanded = await readDoneSection(page)
  assert.equal(expanded.rows, DONE_TOTAL, `展开后应渲染 ${DONE_TOTAL} 行`)
  assert.equal(expanded.moreText, '收起')
  assert.equal(expanded.moreExpanded, 'true')
  assert.equal(expanded.titleSize, folded.titleSize, '展开不应改变 done 标题字号')

  const artifacts = join(WORKTREE, '.dev', 'e2e-artifacts', `board-done-paging-${process.pid}`)
  mkdirSync(artifacts, { recursive: true })
  await page.screenshot({ path: join(artifacts, 'expanded.png') })
  console.log(`[e2e] 截图 ${join(artifacts, 'expanded.png')}`)

  // 收起：回到基线一页，按钮文案也回到「展开其余」。
  await page.locator(MORE_BUTTON).click()
  await waitFor({
    description: '「收起」按钮变回「展开其余」',
    check: async () => (await readDoneSection(page)).moreText === '展开其余 1 个卡片',
    timeoutMs: 10_000,
  })
  const collapsed = await readDoneSection(page)
  assert.equal(collapsed.rows, PAGE_SIZE, `收起后应回到 ${PAGE_SIZE} 行`)
  assert.equal(collapsed.moreExpanded, 'false')

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
