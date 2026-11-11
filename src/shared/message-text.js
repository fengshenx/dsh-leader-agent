/**
 * 消息内容块的纯文本提取、气泡正文的 Markdown 源码整理与渲染格式判定。
 *
 * 宿主只把 `content` 当作开放 JSON，不约束形状，读的时候自己判型。这些函数
 * 同时服务 host 侧（通知正文、转录折叠）与 client 侧（气泡正文）：后者不能 import
 * `src/host/`（`message.js` 带 `node:crypto`），所以放在 shared。
 *
 * @module dsh-leader-agent/shared/message-text
 */

/**
 * Markdown 块级标记：只有行首的块级语法改变分段方式。
 *
 * 行内语法（`**粗**`、`` `code` ``）不参与判定——多行正文缺块级标记与空行时，
 * Markdown 会把整段软换行折成一段。
 */
const BLOCK_MARKERS = [
  /^#{1,6}[ \t]/m, // 标题
  /^[ \t]*>/m, // 引用
  /^[ \t]*(?:```|~~~)/m, // 围栏代码块
  /^[ \t]*\|/m, // 表格
  /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/m, // 列表
  /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/m, // 水平线
]

/**
 * 从消息内容块里取出纯文本。
 *
 * @param {unknown} content - 消息的内容块数组
 * @param {string} [separator] - 块间分隔符；气泡用默认的 `\n`，通知正文的多块
 *   用 `\n\n`（单个 `\n` 是软换行，多个块会被折成一段）
 * @returns {string} 拼接后的文本
 */
export function messageText(content, separator = '\n') {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && !Array.isArray(block)
      && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(separator)
    .trim()
}

const FENCE_TOKEN = /^(`{3,}|~{3,})(.*)$/
const QUOTE_PREFIX = /^ {0,3}>[ \t]?/
const LIST_PREFIX = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/

/**
 * 把文本从 `startColumn` 列往后推进，返回推进后的列号。
 *
 * tab 按 CommonMark 展开到下一个 4 列边界，且展开宽度取决于它所在的列：容器前缀里
 * 也可能出现 tab（例如 `>\t`），不能按字符数累加。
 *
 * @param {string} text - 要推进的文本
 * @param {number} startColumn - 起始列号（0 起）
 * @returns {number} 推进后的列号
 */
function advanceColumns(text, startColumn) {
  let column = startColumn
  for (const char of text) {
    column = char === '\t' ? column + 4 - (column % 4) : column + 1
  }
  return column
}

/**
 * 扫描行首容器，返回容器栈、剩余内容与内容起始列。
 *
 * 围栏里不能像开栏那样再剥一遍 `>` / `- `：代码内容里的这些字符是字面量。
 * 所以只在开栏时记下容器栈，之后逐行用栈来核对：块引用必须仍有 `>` 标记，
 * 列表项必须仍缩进到内容起始列。列表续行不重复列表标记，只能靠缩进判断。
 *
 * @param {string} line - 原始行
 * @returns {{ containers: Array<{ kind: 'quote' | 'list', contentColumn: number }>,
 *   rest: string, column: number }} 容器栈、去掉容器前缀后的内容与内容起始列
 */
function scanContainers(line) {
  let rest = line
  let column = 0
  const containers = []
  for (;;) {
    const quote = QUOTE_PREFIX.exec(rest)
    if (quote !== null) {
      rest = rest.slice(quote[0].length)
      column = advanceColumns(quote[0], column)
      containers.push({ kind: 'quote', contentColumn: column })
      continue
    }
    const list = LIST_PREFIX.exec(rest)
    if (list !== null) {
      rest = rest.slice(list[0].length)
      column = advanceColumns(list[0], column)
      containers.push({ kind: 'list', contentColumn: column })
      continue
    }
    return { containers, rest, column }
  }
}

/**
 * 判断剩余内容在容器内容起始列之后 0–3 列处是否是关闭行。
 *
 * @param {string} rest - 已经核对过外层容器的剩余内容
 * @param {number} baseColumn - 最内层容器内容起始列（0 起）
 * @param {{ char: string, length: number }} fence - 开栏字符与长度
 * @returns {boolean} 是否关闭围栏
 */
function isFenceClose(rest, baseColumn, fence) {
  const leading = /^[ \t]*/.exec(rest)[0]
  const relative = advanceColumns(leading, baseColumn) - baseColumn
  if (relative > 3) return false
  const marker = FENCE_TOKEN.exec(rest.slice(leading.length))
  if (marker === null) return false
  return marker[1][0] === fence.char && marker[1].length >= fence.length && marker[2].trim() === ''
}

/**
 * 用开栏时的容器栈核对围栏里的一行。
 *
 * 块引用按行重复标记，逐层剥；列表续行靠缩进，缩进不到内容起始列说明列表项
 * 已经在这一行结束，围栏随之结束。列表项结束时如果这一行在剩余容器里是关闭行，
 * 仍要按关闭行处理——`> - ``` ` 的关闭行常常只带 `> `，不带列表缩进。
 *
 * @param {string} line - 原始行
 * @param {{ char: string, length: number,
 *   containers: Array<{ kind: string, contentColumn: number }> }} fence -
 *   开栏字符、长度与容器栈
 * @returns {'close' | 'inside' | 'outside'} 关闭行、围栏内容还是容器已结束
 */
function fenceLineState(line, fence) {
  let rest = line
  let column = 0
  let base = 0
  for (const container of fence.containers) {
    if (container.kind === 'quote') {
      const quote = QUOTE_PREFIX.exec(rest)
      if (quote === null) return 'outside'
      rest = rest.slice(quote[0].length)
      column = advanceColumns(quote[0], column)
      base = column
      continue
    }
    const leading = /^[ \t]*/.exec(rest)[0]
    if (advanceColumns(leading, column) < container.contentColumn) {
      return isFenceClose(rest, column, fence) ? 'close' : 'outside'
    }
    const needed = container.contentColumn - column
    if (needed > 0 && leading.startsWith(' '.repeat(needed))) {
      rest = rest.slice(needed)
      column = container.contentColumn
    }
    base = container.contentColumn
  }
  return isFenceClose(rest, base, fence) ? 'close' : 'inside'
}

/**
 * 把 Markdown 源码里的软换行改成硬换行。
 *
 * leader 任务正文经常逐行写「做什么 / 边界 / 验收」，交给 Markdown 会被软换行
 * 折成一段。逐行补两个尾随空格后，GFM 把换行渲染成 `<br>`，逐行结构与行内
 * Markdown（粗体、行内代码、链接）可以同时成立。
 *
 * 围栏代码块与缩进代码块内的换行是代码内容，不能补空格；空行本来就是段落边界，
 * 也不需要补。围栏不用绝对列判断，而是开栏时记下容器栈，之后每行用栈核对
 * （块引用看标记、列表看内容起始列），关闭行相对最内层容器内容起始列缩进 0–3 列；
 * 列表项结束时围栏随之结束，行首 tab 按 CommonMark 展开到 4 列边界。
 *
 * @param {string} text - Markdown 源码
 * @returns {string} 软换行已改成硬换行的源码
 */
export function hardBreakMarkdown(text) {
  if (typeof text !== 'string' || text === '') return ''
  const lines = text.split('\n')
  const scanned = lines.map(scanContainers)
  let fence = null
  return lines.map((line, index) => {
    if (fence !== null) {
      const state = fenceLineState(line, fence)
      if (state !== 'outside') {
        if (state === 'close') fence = null
        return line
      }
      // 容器已结束，围栏跟着结束；这一行按普通正文继续判断。
      fence = null
    }
    const { containers, rest, column } = scanned[index]
    const leading = /^[ \t]*/.exec(rest)[0]
    const relative = advanceColumns(leading, column) - column
    if (relative <= 3) {
      const marker = FENCE_TOKEN.exec(rest.slice(leading.length))
      if (marker !== null) {
        fence = { char: marker[1][0], length: marker[1].length, containers }
        return line
      }
    }
    // 最后一行、空行与后随空行的行不需要硬换行：段落边界已经由空行表达。
    if (index === lines.length - 1 || rest.trim() === '' || scanned[index + 1].rest.trim() === '') return line
    if (relative >= 4) return line
    // 已经是硬换行（两个尾随空格或反斜杠）就不重复补，反斜杠后补空格会改掉语义。
    if (/ {2,}$/.test(line) || /\\$/.test(line)) return line
    return `${line}  `
  }).join('\n')
}

/**
 * 决定一段正文按 Markdown 还是纯文本渲染。
 *
 * 只有三种情形判 Markdown：整段没有换行（单行不存在折段，行内语法照常渲染）、
 * 含空行（`\n\n` 是段落边界）、含行首块级标记（标题、列表、围栏、表格、引用）。
 * 其余多行正文交给 Markdown 会被软换行折成一段——那是逐行协议字段的坑。
 *
 * leader 任务气泡不走这条判据：它始终按 Markdown 渲染，逐行结构由
 * `hardBreakMarkdown` 保住。这里服务的是 worker 回报（失败原因、旧回报回退的
 * 协议行必须保持纯文本）。
 *
 * @param {unknown} text - 正文
 * @returns {'markdown' | 'text'} 渲染方式
 */
export function bubbleFormat(text) {
  if (typeof text !== 'string' || text === '') return 'text'
  if (!text.includes('\n')) return 'markdown'
  if (text.includes('\n\n')) return 'markdown'
  return BLOCK_MARKERS.some((marker) => marker.test(text)) ? 'markdown' : 'text'
}
