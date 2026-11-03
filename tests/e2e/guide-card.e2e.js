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
import { startMockProvider } from './mock-llm.mjs'

/** 场景标记：mock 用它选脚本。 */
const MARKER = 'MOCK-GUIDE'
const REPLY = '收到，先干活'

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
  const mock = await startMockProvider({ scripts: { [MARKER]: [{ text: REPLY }] } })
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

  // 三、没关过的新浏览器里，发出第一句话后卡片自然消失。
  const fresh = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const freshPage = await fresh.newPage()
  await openLeader(freshPage)
  await card(freshPage).waitFor({ state: 'visible', timeout: 30_000 })
  const composer = freshPage.locator('div[role="textbox"][contenteditable="true"]').first()
  await composer.click()
  await composer.fill(`${MARKER} 你好`)
  await composer.press('Enter')
  await freshPage.getByText(REPLY).first().waitFor({ state: 'visible', timeout: 90_000 })
  await card(freshPage).waitFor({ state: 'detached', timeout: 10_000 })

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
})
