/**
 * e2e 场景的组合夹具：mock provider + 隔离实例 + chromium。
 *
 * 三条硬约束（都来自宿主 web 车道的实测结论，删掉任何一条都会让套件认证坏 wire）：
 * - **pageerror / console.error 即失败**：页内异常被重连与历史重同步自愈时，
 *   场景会绿着通过，实际断了一条通路。
 * - **按状态同步，不用 sleep**：等 DOM 稳定、等落盘文件出现，等某个具体状态。
 * - **不设重试**：失败就是失败，重试只会把竞态藏起来。
 *
 * @module dsh-leader-kit/tests/e2e/harness
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { WORKTREE, startInstance } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'

/**
 * 起一个可直接断言的场景。
 *
 * @param {object} [options] - 选项
 * @param {Record<string, object[]>} [options.scripts] - mock 脚本，见 `mock-script.mjs`
 * @param {string} [options.locale] - 浏览器语言，默认 `zh-CN`（断言中文文案的场景）
 * @param {string} [options.name] - 场景名，截图目录用它；默认 `scenario`
 * @param {Record<string, string>} [options.env] - 额外的实例环境变量
 * @returns {Promise<object>} 场景句柄：页面、实例、mock、问题列表、截图与幂等停止函数
 */
export async function launchE2E({ scripts = {}, locale = 'zh-CN', name = 'scenario', env = {} } = {}) {
  const mock = await startMockProvider({ scripts })
  let instance = null
  let browser = null
  let context = null
  let page = null
  try {
    instance = await startInstance({ baseUrl: mock.url, env })
    browser = await chromium.launch()
    context = await browser.newContext({ locale, viewport: { width: 1440, height: 900 } })
    page = await context.newPage()
  } catch (error) {
    // 起不来时把已拿到的资源收掉，否则端口与临时根会留给下一个用例背锅。
    // 清理自身的错误不能盖住真正的失败原因，这里逐条吞掉。
    await browser?.close().catch(() => {})
    await instance?.stop().catch(() => {})
    await mock.stop().catch(() => {})
    throw error
  }

  /** 失败时随断言一起打印：只看断言文本会漏掉页内真正的报错。 */
  const problems = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })

  // 截图落在工作树的 .dev/（已 gitignore）：给人看的证据，不入库、不替代断言。
  // 带上 pid：同机并发两次 e2e 时同名场景不互相覆盖，读数才对得上图。
  const artifactsDir = join(WORKTREE, '.dev', 'e2e-artifacts', `${name}-${process.pid}`)

  /**
   * 存一张当前页面截图，路径打到 stdout 供人或 agent 直接打开。
   *
   * @param {string} label - 文件名（不含扩展名），描述这一步要证明什么
   * @returns {Promise<string>} 截图路径
   */
  const screenshot = async (label) => {
    mkdirSync(artifactsDir, { recursive: true })
    const file = join(artifactsDir, `${label}.png`)
    await page.screenshot({ path: file })
    console.log(`[e2e] 截图 ${file}`)
    return file
  }

  let stopped = false
  return {
    page,
    context,
    instance,
    mock,
    problems,
    screenshot,
    /** 打开实例首页；token 在 query 上，宿主换 cookie 后会重定向到干净地址。 */
    async open() {
      await page.goto(instance.url, { waitUntil: 'domcontentloaded' })
      return page
    },
    async stop() {
      if (stopped) return
      stopped = true
      const failures = []
      const attempt = async (label, action) => {
        try {
          await action()
        } catch (error) {
          failures.push(`${label}: ${error.message}`)
        }
      }
      // 关浏览器前先留最后一帧：断言失败时这张图往往就是唯一能看的东西。
      await attempt('保存结尾截图', () => screenshot('final'))
      // 顺序固定：先关浏览器（它连着实例），再停实例，最后停 mock 与删数据根。
      await attempt('关闭浏览器', () => browser.close())
      await attempt('停止实例', () => instance.stop())
      await attempt('停止 mock', () => mock.stop())
      if (failures.length > 0) throw new Error(`e2e 清理失败：\n${failures.join('\n')}`)
    },
  }
}

/**
 * 轮询直到取值为真，超时则带上最后一次的观察结果报错。
 *
 * 不用固定 sleep：机器快慢决定成功与否的断言不是证据。
 *
 * @param {object} options - 选项
 * @param {() => Promise<unknown>} options.check - 每次轮询的取值函数，返回真值即结束
 * @param {string} options.description - 报错时说明在等什么
 * @param {number} [options.timeoutMs] - 预算，默认 15 秒
 * @param {number} [options.intervalMs] - 轮询间隔，默认 100 毫秒
 * @returns {Promise<unknown>} 第一次为真的取值
 */
export async function waitFor({ check, description, timeoutMs = 15_000, intervalMs = 100 }) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await check()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${description}；最后一次观察：${JSON.stringify(last)}`)
}

/**
 * 页面读数：区分「数据没到」与「渲染错了」。
 *
 * 只读宿主左栏的通用结构与插件的容器/行，不读文案——读数是失败时的附加证据，
 * 不参与断言。
 *
 * @param {import('playwright').Page} page - 页面
 * @returns {Promise<object>} 会话行、工作区行、输入框与插件元素的当前计数
 */
export async function describePage(page) {
  try {
    return await page.evaluate(() => ({
      url: location.href,
      rowKeys: [...document.querySelectorAll('[data-row-key]')].map((node) => node.getAttribute('data-row-key')),
      composer: document.querySelector('div[role="textbox"][contenteditable="true"]') !== null,
      leaderKit: {
        sections: document.querySelectorAll('.dsh-leader-kit-project-section').length,
        projectRows: document.querySelectorAll('.dsh-leader-kit-project-row').length,
        guideCards: document.querySelectorAll('.dsh-leader-kit-guide-card').length,
        excluded: document.querySelectorAll('.dsh-leader-kit-excluded-session').length,
      },
    }))
  } catch (error) {
    // 页面已经关掉时读不到 DOM：读数只是附加证据，不能盖住真正的失败原因。
    return { unavailable: error.message }
  }
}

/**
 * 等元素进入目标状态，失败时把页面读数一起报出来。
 *
 * 预算按「这一步正常情况下要多久」给：实测单个场景 3–8 秒，元素通常 1–2 秒内
 * 到位。写成 60 秒只会让失败多干等一分钟，还把「机器慢」与「等错了元素」混成
 * 同一个症状。
 *
 * @param {import('playwright').Locator} locator - 目标元素
 * @param {object} options - 选项
 * @param {string} options.description - 报错时说明在等什么
 * @param {'attached'|'visible'|'detached'|'hidden'} [options.state] - 等待的状态，默认 `visible`
 * @param {number} [options.timeoutMs] - 预算，默认 15 秒
 * @returns {Promise<void>} 元素进入目标状态
 */
export async function waitForLocator(locator, { description, state = 'visible', timeoutMs = 15_000 }) {
  try {
    await locator.waitFor({ state, timeout: timeoutMs })
  } catch (error) {
    const snapshot = await describePage(locator.page())
    throw new Error(
      `等待超时（${timeoutMs}ms）：${description}；locator ${locator}；页面读数 ${JSON.stringify(snapshot)}`,
      { cause: error },
    )
  }
}
