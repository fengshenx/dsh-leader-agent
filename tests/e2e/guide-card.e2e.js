/**
 * leader 会话引导卡：出现条件、关闭、发出首条消息后消失。
 *
 * 卡片只在「当前会话是某项目的 leader 且一条消息都没有」时出现，这个判据来自宿主
 * 会话快照的 `blank`——只有真实宿主能给出它。项目注册表只在启动时读回内存，所以
 * 场景必须「起一次拿 leader 会话 id 与 cwd → 停 → 写 `projects.json` → 用同一个
 * 数据根再起一次」。
 *
 * 引导期间会话事件数必须为 0：断言落在「模型请求数为 0」与「会话日志里没有
 * user/message」上，不看界面上的字。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { WORKTREE, startInstanceIn } from './instance.mjs'
import { waitFor } from './harness.mjs'
import { zh } from '../../src/client/locales.js'
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
  mkdirSync(join(home, 'dsh-leader-kit'), { recursive: true })
  writeFileSync(join(home, 'dsh-leader-kit', 'projects.json'), `${JSON.stringify({
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

test('引导卡只在空 leader 会话里出现，关掉或说完第一句话就消失', { timeout: 300_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-kit-e2e-guide-'))
  // 引导发出的那句话不带场景标记，mock 会按「没有标记」回 400：这里要证明的是
  // 「消息发出去并走了一轮模型」，不是模型答得对不对。
  const mock = await startMockProvider({})
  const problems = []
  let browser = null
  let instance = null

  t.after(async () => {
    await browser?.close().catch(() => {})
    await instance?.stop().catch(() => {})
    await mock.stop().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  })

  // 第一段：让宿主建出它自己的空会话，拿到 id 与 cwd。
  const first = await startInstanceIn({ root, baseUrl: mock.url })
  browser = await chromium.launch()
  const bootstrap = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const bootstrapPage = await bootstrap.newPage()
  await bootstrapPage.goto(first.url, { waitUntil: 'domcontentloaded' })
  await bootstrapPage.locator('div[role="textbox"][contenteditable="true"]').first()
    .waitFor({ state: 'visible', timeout: 60_000 })
  const session = firstSession(first.home)
  assert.notEqual(session, null, '宿主启动后应有一个落盘的空会话')
  await bootstrap.close()
  await first.stop({ keepRoot: true })

  seedProject(first.home, session)

  // 第二段：同一个数据根，项目注册表在启动时读回内存。
  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second
  const ready = async (page) => {
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
    })
    await page.goto(second.url, { waitUntil: 'domcontentloaded' })
    return page.locator('.dsh-leader-kit-project-row').first()
  }
  const card = (page) => page.locator('.dsh-leader-kit-guide-card')
  const openLeader = async (page) => {
    const row = await ready(page)
    await row.waitFor({ state: 'visible', timeout: 60_000 })
    await row.click()
  }

  // 一、卡片出现，且引导期间没有任何模型请求。
  const page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })).newPage()
  await openLeader(page)
  await card(page).waitFor({ state: 'visible', timeout: 30_000 })
  assert.match(await card(page).innerText(), /这个目录有一个 Leader 了/, '卡片标题应来自 locale 字典')
  // 视觉硬指标：与输入框外壳同宽同边界。输入框外壳是编辑器往上第一个带
  // max-width 的祖先（宿主自己就是靠它把输入框收在内容列宽内的）。
  const box = await page.evaluate(() => {
    const card = document.querySelector('.dsh-leader-kit-guide-card')
    const editor = document.querySelector('div[role="textbox"][contenteditable="true"]')
    let shell = editor
    while (shell && getComputedStyle(shell).maxWidth === 'none') shell = shell.parentElement
    const a = card.getBoundingClientRect()
    const b = shell.getBoundingClientRect()
    const title = card.querySelector('.dsh-leader-kit-guide-title')
    const steps = card.querySelector('.dsh-leader-kit-guide-steps')
    return {
      width: Math.abs(a.width - b.width),
      left: Math.abs(a.left - b.left),
      right: Math.abs(a.right - b.right),
      height: a.height,
      titleSize: parseFloat(getComputedStyle(title).fontSize),
      stepsSize: parseFloat(getComputedStyle(steps).fontSize),
      round: getComputedStyle(card).borderRadius,
      shellRound: getComputedStyle(shell).borderRadius,
    }
  })
  assert.ok(box.width <= 1 && box.left <= 1 && box.right <= 1, `引导条与输入框没有对齐：${JSON.stringify(box)}`)
  assert.equal(box.round, box.shellRound, '引导条圆角应与输入框取同一个 token')
  assert.ok(box.titleSize >= 14 && box.stepsSize >= 13, `字号小于宿主正文档：${JSON.stringify(box)}`)
  assert.ok(box.height <= 80, `引导条不够紧凑：${box.height}px`)
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
  await card(page).waitFor({ state: 'detached', timeout: 10_000 })
  await openLeader(page)
  await page.locator('div[role="textbox"][contenteditable="true"]').first()
    .waitFor({ state: 'visible', timeout: 30_000 })
  await card(page).waitFor({ state: 'detached', timeout: 5_000 })
  assert.equal(await card(page).count(), 0, '关过的会话重载后不该再出现引导卡')

  // 三、没关过的新浏览器里点「让它介绍一下自己」：消息真的发出去（用户消息上屏、
  // 走一轮模型），卡片随即因为转录不再为空而消失。
  const fresh = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const freshPage = await fresh.newPage()
  await openLeader(freshPage)
  await card(freshPage).waitFor({ state: 'visible', timeout: 30_000 })
  const beforeRequests = mock.requests.length
  await freshPage.screenshot({ path: join(artifacts, 'before-click.png') })
  await freshPage.getByRole('button', { name: zh['guide.action.intro'] }).click()
  // 用户消息的容器是宿主 chat 节点的 data-chat-flow-kind="user"；不用「文本包含
  // 某句话」定位——引导卡自己的文案里也有同一句话，那样断言会被卡片命中。
  const bubble = freshPage.locator('[data-chat-flow-kind="user"]')
  await bubble.first().waitFor({ state: 'visible', timeout: 30_000 })
  await card(freshPage).waitFor({ state: 'detached', timeout: 15_000 })
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
    timeoutMs: 30_000,
  })
  // 模型请求在日志写入之后才发出：等它到 mock，别紧接着断言时序。
  await waitFor({
    description: `点击后应走一轮模型请求（此前 ${beforeRequests} 次）`,
    check: () => mock.requests.length > beforeRequests,
    timeoutMs: 30_000,
  })
  assert.equal(await card(freshPage).count(), 0, '发出消息后引导卡应从界面上消失')

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
