/**
 * e2e 场景的组合夹具：mock provider + 隔离实例 + chromium。
 *
 * 三条硬约束（都来自宿主 web 车道的实测结论，删掉任何一条都会让套件认证坏 wire）：
 * - **pageerror / console.error 即失败**：页内异常被重连与历史重同步自愈时，
 *   场景会绿着通过，实际断了一条通路。宿主自己记成 error 的预期取消按文案放行，
 *   见 {@link EXPECTED_SESSION_RELEASE}。
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

/** 失败读数的上限：页面主线程卡死时，读数不能把 20 秒的失败放大成 `node:test` 的 180 秒。 */
const READ_BUDGET_MS = 2_000

/** 关闭浏览器的上限：正常关闭不到 1 秒，等满说明浏览器进程没干净退出。 */
const CLOSE_BUDGET_MS = 10_000

/**
 * 宿主自己记成 `console.error` 的预期取消。
 *
 * `ui-sidebar-right/src/client/session-view.ts` 在构造时订阅 `reference.ready`，失败就打
 * `Sidebar Session opening failed:`；而 `release()` 必然让 readiness 以 `is released` reject。
 * 视图在 ready 之前被销毁（快速切换会话）因此必然打出这条——它是取消，不是故障。
 * 宿主自己的 e2e 也只把特定文案的 warning 与 pageerror 当失败，没有把任意 console.error 当失败。
 */
const EXPECTED_SESSION_RELEASE = /Sidebar Session opening failed: .*is released/

/**
 * 收集页内不该出现的异常：未捕获异常与 console.error。
 *
 * 已知的预期取消按文案放行（见 {@link EXPECTED_SESSION_RELEASE}），其余一律失败——
 * 放大到「所有 console.error 都放行」会漏掉插件自己的错误。
 *
 * @param {import('playwright').Page} page - 页面
 * @param {string[]} [problems] - 归集的数组，默认新建
 * @returns {string[]} 随页面生命周期增长的异常列表，场景末尾断言为空
 */
export function watchProblems(page, problems = []) {
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (EXPECTED_SESSION_RELEASE.test(text)) return
    problems.push(`console.error: ${text}`)
  })
  return problems
}

let warnedScale = false

/**
 * 预算倍率：慢机与 2 核 CI 上首屏可能超过 20 秒，`E2E_BUDGET_SCALE=1.5` 整体放宽，
 * 不用改代码。非法值只告警一次——静默按 1 处理会让人以为已经放宽，继续盯着一片红。
 *
 * @returns {number} 倍率，默认 1
 */
function budgetScale() {
  const raw = process.env.E2E_BUDGET_SCALE
  if (raw === undefined || raw === '') return 1
  const scale = Number(raw)
  if (Number.isFinite(scale) && scale > 0) return scale
  if (!warnedScale) {
    warnedScale = true
    console.warn(`[e2e] E2E_BUDGET_SCALE=${raw} 不是正数，按 1 处理`)
  }
  return 1
}

/**
 * 给一个读数加时间上限。
 *
 * `page.evaluate` 没有 timeout 参数（Playwright 的签名只有 `exposeFunctions`），页面
 * 主线程卡死时它会一直挂着：失败于是从 20 秒放大到 `node:test` 的 180 秒上限，原始
 * 读数反而一起丢掉。
 *
 * @param {Promise<unknown>} reading - 读数，必须自带 catch（race 落败后仍可能 reject）
 * @param {number} timeoutMs - 上限
 * @param {object} fallback - 超时后返回的退化读数
 * @returns {Promise<unknown>} 读数或退化读数
 */
async function withDeadline(reading, timeoutMs, fallback) {
  let timer
  try {
    return await Promise.race([
      reading,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 关浏览器，最多等 `timeoutMs`。
 *
 * Playwright 的 `close()` 在浏览器进程没干净退出时既不 resolve 也不 reject，
 * `await browser.close().catch(...)` 只处理拒绝——未 settle 的 promise 会让清理阶段
 * 永久挂住。实测症状是全量偶发卡几分钟、测试进程 0% CPU、没有任何报错输出。
 *
 * @param {import('playwright').Browser | null} browser - 浏览器句柄
 * @param {number} [timeoutMs] - 上限，默认 10 秒
 * @returns {Promise<boolean>} 是否在预算内关闭
 */
export async function closeBrowser(browser, timeoutMs = CLOSE_BUDGET_MS) {
  if (browser === null || browser === undefined) return true
  let timer
  const closed = browser.close().then(() => true, () => true)
  const inBudget = await Promise.race([
    closed,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    }),
  ])
  clearTimeout(timer)
  // 超时不抛：清理阶段抛错会盖住真正的失败原因，但这仍然是需要看见的异常。
  if (!inBudget) console.warn(`[e2e] 关闭浏览器超过 ${timeoutMs}ms，继续清理`)
  return inBudget
}

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
    await closeBrowser(browser)
    await instance?.stop().catch(() => {})
    await mock.stop().catch(() => {})
    throw error
  }

  /** 失败时随断言一起打印：只看断言文本会漏掉页内真正的报错。 */
  const problems = watchProblems(page)

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
      await attempt('关闭浏览器', () => closeBrowser(browser))
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
 * @param {number} [options.timeoutMs] - 预算，默认 15 秒；`E2E_BUDGET_SCALE` 可整体放大
 * @param {number} [options.intervalMs] - 轮询间隔，默认 100 毫秒
 * @returns {Promise<unknown>} 第一次为真的取值
 */
export async function waitFor({ check, description, timeoutMs = 15_000, intervalMs = 100 }) {
  const budgetMs = Math.round(timeoutMs * budgetScale())
  const deadline = Date.now() + budgetMs
  let last
  while (Date.now() < deadline) {
    last = await check()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`等待超时（${budgetMs}ms）：${description}；最后一次观察：${JSON.stringify(last)}`)
}

/**
 * 页面读数：区分「数据没到」与「渲染错了」。
 *
 * 只读宿主左栏的通用结构与插件的容器/行，不读文案——读数是失败时的附加证据，
 * 不参与断言。
 *
 * @param {import('playwright').Page} page - 页面
 * @param {object} [options] - 选项
 * @param {number} [options.timeoutMs] - 读数上限，默认 2 秒
 * @returns {Promise<object>} 会话行、工作区行、输入框与插件元素的当前计数
 */
export async function describePage(page, { timeoutMs = READ_BUDGET_MS } = {}) {
  const reading = page
    .evaluate(() => ({
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
    // 页面已经关掉时读不到 DOM：读数只是附加证据，不能盖住真正的失败原因。
    .catch((error) => ({ unavailable: error.message }))
  return withDeadline(reading, timeoutMs, { unavailable: `页面 ${timeoutMs}ms 内无响应` })
}

/**
 * 目标元素的读数：计数之外再补可见性与尺寸。
 *
 * 只数 count 时分不开「不在 DOM」「在 DOM 但 `display:none`」「在 DOM 但零尺寸」——
 * 这三种在 `waitFor({ state: 'visible' })` 里是同一句超时。
 *
 * @param {import('playwright').Locator} locator - 目标元素
 * @param {number} timeoutMs - 读数上限
 * @returns {Promise<object>} 计数、可见性、边界盒与关键计算样式
 */
async function describeTarget(locator, timeoutMs) {
  const reading = (async () => {
    const count = await locator.count()
    if (count === 0) return { count, inDom: false }
    const target = locator.first()
    const [visible, box, style] = await Promise.all([
      target.isVisible(),
      target.boundingBox(),
      target.evaluate((node) => {
        const computed = getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return {
          checkVisibility: node.checkVisibility({ checkVisibilityCSS: true }),
          display: computed.display,
          visibility: computed.visibility,
          opacity: computed.opacity,
          rect: [Math.round(rect.width), Math.round(rect.height)],
        }
      }),
    ])
    return { count, visible, box, ...style }
  })().catch((error) => ({ error: error.message }))
  return withDeadline(reading, timeoutMs, { error: `目标元素 ${timeoutMs}ms 内无响应` })
}

/**
 * 等元素进入目标状态，失败时把目标与页面读数一起报出来。
 *
 * 预算按「这一步正常情况下要多久」给：实测单个场景 3–8 秒，元素通常 1–2 秒内
 * 到位。写成 60 秒只会让失败多干等一分钟，还把「机器慢」与「等错了元素」混成
 * 同一个症状。
 *
 * @param {import('playwright').Locator} locator - 目标元素
 * @param {object} options - 选项
 * @param {string} options.description - 报错时说明在等什么
 * @param {'attached'|'visible'|'detached'|'hidden'} [options.state] - 等待的状态，默认 `visible`
 * @param {number} [options.timeoutMs] - 预算，默认 15 秒；`E2E_BUDGET_SCALE` 可整体放大
 * @returns {Promise<void>} 元素进入目标状态
 */
export async function waitForLocator(locator, { description, state = 'visible', timeoutMs = 15_000 }) {
  const budgetMs = Math.round(timeoutMs * budgetScale())
  try {
    await locator.waitFor({ state, timeout: budgetMs })
  } catch (error) {
    const [target, snapshot] = await Promise.all([
      describeTarget(locator, READ_BUDGET_MS),
      describePage(locator.page()),
    ])
    // 页面/浏览器已关掉与「元素没出现」是两回事：前者要去看清理与崩溃，后者才查选择器。
    const headline =
      error.name === 'TimeoutError' ? `等待超时（${budgetMs}ms）` : `等待失败：${error.message.split('\n')[0]}`
    throw new Error(
      `${headline}：${description}；locator ${locator}；目标读数 ${JSON.stringify(target)}；页面读数 ${JSON.stringify(snapshot)}`,
      { cause: error },
    )
  }
}
