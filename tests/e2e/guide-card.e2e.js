/**
 * leader 会话引导卡：出现条件、关闭、发出首条消息后消失。
 *
 * 卡片只在「当前会话是某项目的 leader 且一条消息都没有」时出现，这个判据来自宿主
 * 会话快照的 `blank`——只有真实宿主能给出它。项目注册表只在启动时读回内存，所以
 * 场景必须「起一次拿 leader 会话 id 与 cwd → 停 → 写 `projects.json` → 用同一个
 * 数据根再起一次」。
 *
 * 引导期间会话事件数必须为 0：断言落在「模型请求数为 0」与「会话日志里没有
 * user/message」上，不看界面上的字。卡片与输入框的对齐、字号、圆角属于样式，
 * 不写进 e2e。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { WORKTREE, startInstanceIn } from './instance.mjs'
import { scenarioTimeout, stopScenario, waitFor, waitForLocator, watchProblems } from './harness.mjs'
import { LOCALE_UI } from '../../src/client/locales.js'

const zh = LOCALE_UI.zh
import { startMockProvider } from './mock-llm.mjs'

/** 引导按钮发出去的那句话：直接取产品文案，不在测试里另抄一份。 */
const INTRO_PROMPT = zh['guide.intro.prompt']

/**
 * 从数据根里取第一个会话的 id 与 cwd。
 *
 * 宿主在启动时自动建一个空会话并落盘：日志首行是 `session` 事件，带 id 与 cwd。
 *
 * @param {string} home - 实例数据根
 * @returns {{ id: string, cwd: string } | null} 会话身份；还没有日志时为 null
 */
function firstSession(home) {
  for (const text of readSessionLogs(home)) {
    const line = text.split('\n').find((item) => item !== '')
    if (line === undefined) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'session' && typeof event.id === 'string' && typeof event.cwd === 'string') {
        return { id: event.id, cwd: event.cwd }
      }
    } catch {
      // 正在写的日志可能读到半行：下一份或下一轮再看。
      continue
    }
  }
  return null
}

/**
 * 把 leader 会话登记成项目。
 *
 * 项目目录必须等于会话 cwd：宿主要把会话挂到项目工作区上，目录不一致时 attach
 * 直接失败（「cannot attach session …」），会话打不开，卡片也就永远不渲染。
 *
 * @param {string} home - 实例数据根
 * @param {{ id: string, cwd: string }} session - leader 会话
 * @returns {void}
 */
function seedProject(home, session) {
  mkdirSync(join(home, 'dsh-leader-agent'), { recursive: true })
  writeFileSync(join(home, 'dsh-leader-agent', 'projects.json'), `${JSON.stringify({
    version: 1,
    projects: [{
      id: 'e2e-guide-project',
      name: 'guide',
      directory: session.cwd,
      leaderSessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

test('引导卡只在空 leader 会话里出现，关掉或说完第一句话就消失', { timeout: scenarioTimeout() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-guide-'))
  // 引导发出的那句话不带场景标记，mock 会按「没有标记」回 400：这里要证明的是
  // 「消息发出去并走了一轮模型」，不是模型答得对不对。
  const mock = await startMockProvider({})
  const problems = []
  let browser = null
  let instance = null

  t.after(() => stopScenario({ browser, instance, mock, root }))

  // 第一段：让宿主建出它自己的空会话，拿到 id 与 cwd。
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

  // 第二段：同一个数据根，项目注册表在启动时读回内存。
  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second
  const ready = async (page) => {
    watchProblems(page, problems)
    await page.goto(second.url, { waitUntil: 'domcontentloaded' })
    return page.locator('.dsh-leader-agent-project-row').first()
  }
  const card = (page) => page.locator('.dsh-leader-agent-guide-card')
  const openLeader = async (page) => {
    const row = await ready(page)
    await waitForLocator(row, { description: '项目行出现在左栏', timeoutMs: 20_000 })
    await row.click()
  }

  // 一、卡片出现，且引导期间没有任何模型请求。
  const page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })).newPage()
  await openLeader(page)
  await waitForLocator(card(page), { description: '引导卡出现', timeoutMs: 15_000 })
  assert.match(await card(page).innerText(), /这个目录有一个 Leader 了/, '卡片标题应来自 locale 字典')
  const artifacts = join(WORKTREE, '.dev', 'e2e-artifacts', `guide-card-${process.pid}`)
  mkdirSync(artifacts, { recursive: true })
  await page.screenshot({ path: join(artifacts, 'card.png') })
  console.log(`[e2e] 截图 ${join(artifacts, 'card.png')}`)
  assert.equal(mock.requests.length, 0, '引导卡不能触发模型调用')
  assert.equal(
    readSessionLogs(second.home).some((text) => text.includes('user/message')),
    false,
    '引导卡不能往会话里写消息',
  )

  // 二、点「知道了」关掉，重载后不再出现。
  await page.getByRole('button', { name: '知道了' }).click()
  await waitForLocator(card(page), { description: '点「知道了」后引导卡消失', state: 'detached', timeoutMs: 10_000 })
  await openLeader(page)
  await waitForLocator(page.locator('div[role="textbox"][contenteditable="true"]').first(), {
    description: '重载后输入框可编辑',
    timeoutMs: 15_000,
  })
  await waitForLocator(card(page), { description: '重载后引导卡不再出现', state: 'detached', timeoutMs: 5_000 })
  assert.equal(await card(page).count(), 0, '关过的会话重载后不该再出现引导卡')

  // 三、没关过的新浏览器里点「了解怎么用」：消息真的发出去（用户消息上屏、
  // 走一轮模型），卡片随即因为转录不再为空而消失。
  const fresh = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const freshPage = await fresh.newPage()
  await openLeader(freshPage)
  await waitForLocator(card(freshPage), { description: '新浏览器里引导卡出现', timeoutMs: 15_000 })
  const beforeRequests = mock.requests.length
  await freshPage.screenshot({ path: join(artifacts, 'before-click.png') })
  await freshPage.getByRole('button', { name: zh['guide.action.intro'] }).click()
  // 用户消息的容器是宿主 chat 节点的 data-chat-flow-kind="user"；不用「文本包含
  // 某句话」定位——引导卡自己的文案里也有同一句话，那样断言会被卡片命中。
  const bubble = freshPage.locator('[data-chat-flow-kind="user"]')
  await waitForLocator(bubble.first(), { description: '用户消息气泡上屏', timeoutMs: 15_000 })
  await waitForLocator(card(freshPage), { description: '发出消息后引导卡消失', state: 'detached', timeoutMs: 15_000 })
  // 气泡容器里还有时间戳，所以断言落在「存在一个叶子元素，其文本恰好是那句话」。
  const bubbleText = await bubble.first().evaluate(
    (node, text) => [...node.querySelectorAll('*')]
      .some((el) => el.children.length === 0 && (el.textContent ?? '').trim() === text),
    INTRO_PROMPT,
  )
  assert.equal(bubbleText, true, '气泡里应是按钮发出去的那句话')
  await freshPage.screenshot({ path: join(artifacts, 'after-click.png') })
  console.log(`[e2e] 截图 ${join(artifacts, 'before-click.png')} / ${join(artifacts, 'after-click.png')}`)
  await waitFor({
    description: '会话日志里出现引导发出的那条消息',
    check: () => readSessionLogs(second.home).some((text) => text.includes(INTRO_PROMPT)),
  })
  // 模型请求在日志写入之后才发出：等它到 mock，别紧接着断言时序。
  await waitFor({
    description: `点击后应走一轮模型请求（此前 ${beforeRequests} 次）`,
    check: () => mock.requests.length > beforeRequests,
  })
  // 示例卡的规格不能只写在界面上：它要随初始化提示进真正的模型请求，
  // leader 才知道该建什么卡、不能碰文件。这里只看请求体，模型能不能照做由
  // 真实 provider 决定，mock 不模拟这一层。
  const introRequest = mock.requests.filter((request) => request.kind === 'scenario').at(-1)
  assert.ok(introRequest !== undefined, '点击后应有一条场景模型请求')
  assert.match(introRequest.body, /create_card/, '请求里应带建示例卡的指令')
  assert.match(introRequest.body, /Hello World/, '请求里应点名 Hello World 示例卡')
  assert.match(introRequest.body, /list_cards/, '请求里应要求先查重')
  assert.equal(await card(freshPage).count(), 0, '发出消息后引导卡应从界面上消失')

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
