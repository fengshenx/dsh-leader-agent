/**
 * 运行时语言切换：真实宿主里 zh → en → ja → zh。
 *
 * `locale: 'en-US'` 只能证明「首次加载读对了语言」；注册期 thunk、slot 的 `t`
 * 与 `useLocaleRevision` 这条重渲染链只有在不刷新页面、切一次语言之后才真正
 * 被证明。这里同时验证宿主支持的 8 种语言清单，以及随包提供的 ja 字典在
 * 运行时被选中（四处标签逐字等于 ja 字典，证明没有沿回退链落到英文）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { readSessionLogs } from './session-logs.mjs'
import { startInstanceIn } from './instance.mjs'
import { startMockProvider } from './mock-llm.mjs'
import { closeBrowser, scenarioTimeout, stopScenario, waitFor, waitForLocator, watchProblems } from './harness.mjs'
import { workerReportSource } from '../../src/shared/worker-report.js'
import { LOCALE_UI } from '../../src/client/locales.js'

const PROJECT_ID = 'e2e-i18n-switch-project'
const CJK = /[\u4e00-\u9fff]/
/** 宿主 locale 服务实际注册的语言；顺序随 catalog，断言只比集合。 */
const HOST_LANGUAGES = ['中文', 'English', '日本語', 'Español', 'Français', 'Deutsch', 'Русский', 'Português']

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
      name: 'i18n-switch',
      directory: session.cwd,
      leaderSessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  }, null, 2)}\n`)
}

/** 追加一条 worker 回报，让气泡里的复制按钮进入 DOM。 */
function appendWorkerReport(home, session) {
  const path = join(
    home,
    'sessions',
    `--${session.cwd.slice(1).replaceAll('/', '-')}--`,
    session.id,
    'session.v4.jsonl.zstd',
  )
  const compressed = readFileSync(path)
  const lines = zstdDecompressSync(compressed).toString('utf8').split('\n').filter(Boolean)
  const maxSeq = Math.max(...lines.map((line) => JSON.parse(line).seq ?? 0))
  const report = 'Task i18n-switch finished.'
  const source = workerReportSource('i18n-worker', 'child-1', report, 'done', 'completed')
  const event = {
    type: 'user/message',
    seq: maxSeq + 1,
    time: Date.now(),
    data: {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `${report}\nSummary:\ndone` }],
      source,
    },
    surfaceOp: 'append',
  }
  const frame = zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
  writeFileSync(path, Buffer.concat([compressed, frame]))
}

/** 打开设置；默认落在 General，语言行由 locale 插件注册。 */
async function openSettings(page) {
  // 侧栏底部的 launcher 被账号菜单接管，设置入口在「账号菜单 → 设置」里。
  await page.getByRole('button', { name: '账号菜单', exact: true }).first().click()
  const entry = page.getByRole('menuitem', { name: '设置', exact: true }).first()
  await waitForLocator(entry, { description: '账号菜单里的设置入口', timeoutMs: 10_000 })
  await entry.click()
  const dialog = page.locator('[data-shortcut-modal="settings"]')
  await waitForLocator(dialog, { description: '设置面板打开', timeoutMs: 15_000 })
  return dialog
}

/** 设置面板里的语言选择器：先按语言行标题定位，避开权限/模型等同角色下拉。 */
function languageSelector(dialog, title) {
  const row = dialog.getByText(title, { exact: true }).first().locator('xpath=../..')
  return row.locator('button[aria-haspopup="menu"]').first()
}

/** 选一个语言；菜单由 portal 渲染，条目按可见标签找。 */
async function selectLanguage(page, dialog, title, label, nextTitle) {
  await languageSelector(dialog, title).click()
  const item = page.getByRole('menuitem', { name: label, exact: true }).first()
  await waitForLocator(item, { description: `语言菜单里的 ${label}`, timeoutMs: 10_000 })
  await item.click()
  await waitFor({
    description: `语言切到 ${label}`,
    check: async () => (await languageSelector(dialog, nextTitle).innerText()).trim() === label,
    timeoutMs: 10_000,
  })
}

/** 读当前界面上四处用户可见文案；复制按钮是图标，读 aria-label。 */
async function labelsOf(page) {
  return {
    projects: (await page.locator('.dsh-leader-agent-project-header-label').first().innerText()).trim(),
    tab: (await page.locator('span[data-sidebar-right-tab]').first().innerText()).trim(),
    empty: (await page.locator('.dsh-leader-agent-board-empty-title').first().innerText()).trim(),
    copy: await page.locator('.dsh-leader-agent-agent-bubble__copy').first().getAttribute('aria-label'),
    lang: await page.evaluate(() => document.documentElement.lang),
  }
}

/** 断言四类标签与 `<html lang>` 都切到目标语言。 */
async function expectLabels(page, code) {
  const expected = LOCALE_UI[code]
  const expectedLang = code === 'zh' ? 'zh-CN' : code
  // 宿主文档语言与插件渲染是两条订阅链，高负载下可能先后到达；并进同一个
  // 等待条件，避免在切换瞬间读到旧 lang 造成假红。
  await waitFor({
    description: `四处文案与 <html lang> 切到 ${code}`,
    check: async () => {
      const labels = await labelsOf(page).catch(() => null)
      return labels !== null
        && labels.projects === expected['project.label']
        && labels.tab === expected['tab.board']
        && labels.empty === expected['board.empty.title']
        && labels.copy === expected['bubble.copy']
        && labels.lang === expectedLang
    },
    timeoutMs: 15_000,
  })
  const labels = await labelsOf(page)
  assert.equal(labels.projects, expected['project.label'], `${code}: 项目标题不是目标语言：${labels.projects}`)
  assert.equal(labels.tab, expected['tab.board'], `${code}: tab 标题不是目标语言：${labels.tab}`)
  assert.equal(labels.empty, expected['board.empty.title'], `${code}: 空看板标题不是目标语言：${labels.empty}`)
  assert.equal(labels.copy, expected['bubble.copy'], `${code}: 复制按钮不是目标语言：${labels.copy}`)
  assert.equal(labels.lang, expectedLang, `${code}: <html lang> 不是目标语言：${labels.lang}`)
  return labels
}

test('运行时切换语言：zh → en → ja → zh', { timeout: scenarioTimeout() }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-e2e-i18n-switch-'))
  const mock = await startMockProvider({})
  const problems = []
  let browser = null
  let instance = null

  t.after(() => stopScenario({ browser, instance, mock, root }))

  // 先让宿主建出自己的空会话，停机后把项目与 worker 回报写进数据根。
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
  appendWorkerReport(first.home, session)

  const second = await startInstanceIn({ root, baseUrl: mock.url })
  instance = second
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watchProblems(page, problems)
  await page.goto(second.url, { waitUntil: 'domcontentloaded' })

  // 预览说明的按钮随语言变；没弹就继续。
  for (const name of ['继续', 'Continue']) {
    try { await page.getByRole('button', { name, exact: true }).first().click({ timeout: 2000 }) } catch { /* 没弹窗 */ }
  }

  const section = page.locator('.dsh-leader-agent-project-section')
  await waitForLocator(section, { description: '项目区块挂载', timeoutMs: 20_000 })
  const projectRow = page.locator('.dsh-leader-agent-project-row').first()
  await waitForLocator(projectRow, { description: '项目行出现在左栏', timeoutMs: 20_000 })
  await waitFor({
    description: '项目可打开（leader 会话已就绪）',
    check: async () => (await projectRow.getAttribute('data-dead')) === null,
    timeoutMs: 20_000,
  })
  await projectRow.click()
  await waitFor({
    description: '项目行进入选中态',
    check: async () => (await projectRow.getAttribute('data-selected')) === 'true',
    timeoutMs: 15_000,
  })
  await waitForLocator(page.locator('.dsh-leader-agent-agent-bubble').first(), {
    description: 'worker 回报气泡（复制按钮的载体）',
    timeoutMs: 20_000,
  })

  // 右栏看板：空看板标题是第四处要断言的文案。
  await waitForLocator(page.locator('[data-sidebar-right-expand="true"]').first(), {
    description: '右栏的展开按钮', timeoutMs: 15_000,
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
  await waitForLocator(page.locator('.dsh-leader-agent-board-empty-title').first(), {
    description: '空看板标题', timeoutMs: 15_000,
  })

  await expectLabels(page, 'zh')

  const dialog = await openSettings(page)
  await languageSelector(dialog, '语言').click()
  const menuItems = await page.getByRole('menuitem').allInnerTexts()
  const menuLabels = [...menuItems].map((text) => text.trim())
  for (const language of HOST_LANGUAGES) {
    assert.ok(menuLabels.includes(language), `宿主语言清单缺少 ${language}：${menuLabels.join(', ')}`)
  }
  await page.keyboard.press('Escape') // 关掉菜单，设置面板还在

  // zh → en
  await selectLanguage(page, dialog, '语言', 'English', 'Language')
  await expectLabels(page, 'en')
  for (const target of [
    page.locator('.dsh-leader-agent-project-section'),
    page.locator('.dsh-leader-agent-board-list'),
    page.locator('.dsh-leader-agent-agent-bubble').first(),
  ]) {
    const text = await target.innerText()
    assert.equal(CJK.test(text), false, `英文界面出现中文：${text}`)
  }

  // en → ja：插件随包提供 ja 字典，四处标签都应逐字等于日文，而不是走 en 回退。
  // 日文本身含汉字，不能用 CJK 判据；逐字比对才能证明选中的是 ja 字典。
  await selectLanguage(page, dialog, 'Language', '日本語', '言語')
  await expectLabels(page, 'ja')
  const boardText = await page.locator('.dsh-leader-agent-board-list').innerText()
  assert.ok(boardText.includes(LOCALE_UI.ja['board.empty.title']), `日文看板没有显示 ja 字典文案：${boardText}`)

  // ja → zh：恢复中文，证明反向切换也重渲染。
  await selectLanguage(page, dialog, '言語', '中文', '语言')
  await expectLabels(page, 'zh')

  await page.keyboard.press('Escape')
  await waitFor({
    description: '设置面板关闭',
    check: async () => !(await dialog.isVisible()),
    timeoutMs: 10_000,
  })

  assert.deepEqual(problems, [], '页内不应有未处理的异常或 console 错误')
  await closeBrowser(browser)
  browser = null
})
