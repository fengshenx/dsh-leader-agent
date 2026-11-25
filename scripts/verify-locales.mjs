/**
 * locale 门禁：语言文件是唯一来源，客户端不能藏用户可见文案。
 *
 * 检查项：
 * - `locale/*.json` 的 `ui` 键集、占位符、非空值在所有语言里一致；
 * - 生成物 `src/client/locales.generated.js` 与语言文件同步；
 * - `src/client/**` 里没有未被引用的 key；
 * - 客户端字符串字面量里没有中文字符；内部日志/错误按「文件 + 原文」显式豁免，
 *   新增一条中文必须登记，避免用户可见文案悄悄回到组件里。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GENERATED_FILE, generate, readLocales } from '../build/locales.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const clientDir = join(root, 'src/client')

/** 内部日志/错误的中文字面量；用户可见文案必须走 locale 字典。 */
const INTERNAL_CJK = new Set([
  // 内部日志、effect 名与开发期错误：不渲染成界面文案；新增项必须带文件与原文登记。
  "src/client/board.js\x00会话服务不可用",
  "src/client/board-settings.js\x00dsh-leader-agent 设置页",
  "src/client/guide-card.js\x00dsh-leader-agent 引导卡",
  "src/client/icons.js\x00未知图标字形：",
  "src/client/index.js\x00dsh-leader-agent 槽位显示名",
  "src/client/index.js\x00dsh-leader-agent 看板 tab 类型",
  "src/client/index.js\x00dsh-leader-agent 看板 tab 标题",
  "src/client/index.js\x00dsh-leader-agent 看板面板",
  "src/client/index.js\x00dsh-leader-agent 看板入口",
  "src/client/index.js\x00dsh-leader-agent 左栏项目区块",
  "src/client/index.js\x00dsh-leader-agent 提示浮层",
  "src/client/index.js\x00dsh-leader-agent 会话标签栏",
  "src/client/index.js\x00dsh-leader-agent leader 改动卡片隐藏",
  "src/client/index.js\x00dsh-leader-agent: 项目通道初始化失败：",
  "src/client/index.js\x00dsh-leader-agent: 当前宿主没有右栏服务，建卡后不自动打开看板",
  "src/client/index.js\x00.json 不在宿主语言目录里，运行时不会被选中",
  "src/client/index.js\x00dsh-leader-agent 看板监视器",
  "src/client/index.js\x00leader 任务",
  "src/client/index.js\x00worker 回报",
  "src/client/index.js\x00节点注册失败：",
  "src/client/index.js\x00渲染器",
  "src/client/leader-session-index.js\x00dsh-leader-agent: 读取 leader 会话名单失败：",
  "src/client/leader-view.js\x00dsh-leader-agent: leader 视图目标注册失败：",
  "src/client/leader-view.js\x00dsh-leader-agent leader 视图入口",
  "src/client/project-board-monitor.js\x00dsh-leader-agent: 打开看板失败：",
  "src/client/project-board-monitor.js\x00dsh-leader-agent: 读项目卡片失败：",
  "src/client/project-board-monitor.js\x00dsh-leader-agent: 关闭看板 tab 失败：",
  "src/client/project-changes.js\x00dsh-leader-agent: 项目变更订阅回调抛错",
  "src/client/project-panel.js\x00dsh-leader-agent: 10 秒内没有等到会话列表服务，项目区块将没有运行态与会话行",
  "src/client/project-remote.js\x00期望字符串，收到 ",
  "src/client/project-remote.js\x00期望数字，收到 ",
  "src/client/project-remote.js\x00期望链接数组，收到 ",
  "src/client/ready-signal.js\x00dsh-leader-agent: 就绪订阅回调抛错",
  "src/client/session-tabs.js\x00dsh-leader-agent: 读取项目标签数据失败",
  "src/client/slot-retain.js\x00看板无法保留会话 ",
  "src/client/slot-retain.js\x00，槽位状态未知：",
  "src/client/slot-retain.js\x00看板打开会话 ",
  "src/client/slot-retain.js\x00 失败，槽位状态未知：",
  "src/client/worker-report-definition.js\x00worker 回报 start 需要 user/message 事件",
  "src/client/worker-report-definition.js\x00worker 回报 start 需要带 worker 标记的 source",
  "src/client/worker-task-definition.js\x00leader 任务 start 需要 user/message 事件",
  "src/client/worker-task-definition.js\x00leader 任务 start 需要带 task 标记的 source",
])

/** 只扫客户端源码；生成物由 build/locales.mjs 单独比对。 */
function clientFiles() {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.js') && path !== GENERATED_FILE) files.push(path)
    }
  }
  walk(clientDir)
  return files.sort()
}

/**
 * 提取 JS 字符串与模板字面量，跳过注释与代码。
 *
 * 这里不需要完整的 AST；locale 门禁只关心「字符串里有什么」。模板里的
 * `${...}` 会递归回代码态，内部字符串同样会被收集。
 *
 * @param {string} source - 源码
 * @returns {{ text: string, index: number }[]} 字符串片段
 */
function stringsOf(source) {
  const strings = []
  let i = 0
  const lineComment = () => { while (i < source.length && source[i] !== '\n') i += 1 }
  const blockComment = () => {
    i += 2
    while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
    i += 2
  }
  /** 读到当前引号收尾，返回内容；调用时 i 指向开引号。 */
  const quoted = (quote) => {
    const start = i
    i += 1
    let text = ''
    while (i < source.length) {
      const char = source[i]
      if (char === '\\') { text += source[i + 1] ?? ''; i += 2; continue }
      if (char === quote) { i += 1; break }
      text += char
      i += 1
    }
    strings.push({ text, index: start })
  }
  /** 读模板；${...} 里的代码递归扫描。 */
  const template = () => {
    const start = i
    i += 1
    let text = ''
    while (i < source.length) {
      const char = source[i]
      if (char === '\\') { text += source[i + 1] ?? ''; i += 2; continue }
      if (char === '`') { i += 1; break }
      if (char === '$' && source[i + 1] === '{') {
        strings.push({ text, index: start })
        text = ''
        i += 2
        code(1)
        continue
      }
      text += char
      i += 1
    }
    strings.push({ text, index: start })
  }
  /** 正则字面量；整段跳过，免得里面的引号/反引号被当成字符串。 */
  const regex = () => {
    i += 1
    let inClass = false
    while (i < source.length) {
      const char = source[i]
      if (char === '\\') { i += 2; continue }
      if (char === '[') inClass = true
      else if (char === ']') inClass = false
      else if (char === '/' && !inClass) {
        i += 1
        while (i < source.length && /[a-z]/i.test(source[i])) i += 1
        return
      }
      i += 1
    }
  }
  /** 看前一个非空白字符，判断 `/` 是不是正则起始。 */
  const regexStart = () => {
    let j = i - 1
    while (j >= 0 && /\s/.test(source[j])) j -= 1
    if (j < 0) return true
    if ('=(:,[!&|?{};'.includes(source[j])) return true
    return /\b(?:return|typeof|case|delete|void|in|of)\s*$/.test(source.slice(0, i))
  }
  /** 代码态；depth 只为模板 ${} 的收尾服务。 */
  const code = (depth = 0) => {
    while (i < source.length) {
      const char = source[i]
      if (char === '/' && source[i + 1] === '/') { lineComment(); continue }
      if (char === '/' && source[i + 1] === '*') { blockComment(); continue }
      if (char === '/') { if (regexStart()) { regex(); continue } i += 1; continue }
      if (char === "'" || char === '"') { quoted(char); continue }
      if (char === '`') { template(); continue }
      if (depth > 0 && char === '{') { depth += 1; i += 1; continue }
      if (depth > 0 && char === '}') { depth -= 1; i += 1; if (depth === 0) return; continue }
      i += 1
    }
  }
  code()
  return strings
}

/** 1-based 行号，供报错定位。 */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

/** 模板里的占位符集合。 */
function placeholdersOf(template) {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

const locales = readLocales()
const reference = locales.find((locale) => locale.code === 'en')
const problems = []

for (const locale of locales) {
  const keys = Object.keys(locale.ui).sort()
  const referenceKeys = Object.keys(reference.ui).sort()
  if (keys.join('\n') !== referenceKeys.join('\n')) {
    const missing = referenceKeys.filter((key) => !(key in locale.ui))
    const extra = keys.filter((key) => !(key in reference.ui))
    problems.push(`locale/${locale.code}.json 的 ui 键集与 en 不一致；缺 ${missing.join(', ') || '无'}；多 ${extra.join(', ') || '无'}`)
    continue
  }
  for (const key of keys) {
    const value = locale.ui[key]
    if (value.trim() === '') problems.push(`locale/${locale.code}.json: ui.${key} 为空`)
    const expected = placeholdersOf(reference.ui[key]).join(',')
    const actual = placeholdersOf(value).join(',')
    if (actual !== expected) problems.push(`locale/${locale.code}.json: ui.${key} 占位符为 {${actual}}，en 为 {${expected}}`)
  }
}

if (!generate({ check: true })) {
  problems.push('src/client/locales.generated.js 已过期；运行 node build/locales.mjs')
}

const files = clientFiles()
const literals = []
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  for (const literal of stringsOf(source)) {
    literals.push({ file: relative(root, file), source, ...literal })
  }
}

const used = new Set(literals.map((literal) => literal.text))
const keys = new Set(Object.keys(reference.ui))
for (const key of [...keys].sort()) {
  if (!used.has(key)) problems.push(`locale/*.json: key ${key} 在 src/client/** 里没有被引用`)
}

/** 用户可见的 CJK 字面量必须为 0；内部文案按「文件 + 原文」豁免。 */
for (const literal of literals) {
  // CSS 模板里的中文只在注释里，浏览器不会渲染；注释已由 code() 跳过，模板文本要单独剥一次。
  const visible = literal.text.replace(/\/\*[\s\S]*?\*\//g, '')
  if (!/[\u4e00-\u9fff]/.test(visible)) continue
  const id = `${literal.file}\u0000${visible}`
  if (INTERNAL_CJK.has(id)) continue
  problems.push(`${literal.file}:${lineOf(literal.source, literal.index)} 字符串里有中文，用户可见文案必须走 locale 字典：${JSON.stringify(visible)}`)
}

/** 豁免清单也要保持干净：改掉或删掉的内部文案不能永久占位。 */
const seen = new Set(literals.map((literal) => `${literal.file}\u0000${literal.text.replace(/\/\*[\s\S]*?\*\//g, '')}`))
for (const id of INTERNAL_CJK) {
  if (!seen.has(id)) problems.push(`scripts/verify-locales.mjs: 豁免的中文字面量已不存在：${id.replace('\u0000', ': ')}`)
}

if (problems.length > 0) {
  console.error(`locale 门禁失败（${problems.length} 项）：`)
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}

console.log(`locale 门禁通过：${locales.length} 种语言，${keys.size} 个 key，${literals.length} 个字符串字面量`)
