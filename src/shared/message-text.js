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

const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})(.*)$/
const QUOTE_PREFIX = /^ {0,3}>[ \t]?/
const LIST_PREFIX = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/

/**
 * 去掉行首的块引用与列表容器前缀，只用于判断这一行是不是代码块边界。
 *
 * 任务正文里用 `> ``` ` 或 `- ``` ` 包住代码块时，围栏不在行首；不剥掉容器前缀
 * 会把它当普通行，代码内容被补上硬换行空格。容器可以嵌套，循环剥到稳定为止。
 * 同时记下剥掉的前缀宽度与块引用层数：围栏里的关闭行按容器缩进退到内容起始列
 * 再比对，不能靠再剥一次容器标记（那会误伤代码内容）。
 *
 * @param {string} line - 原始行
 * @returns {{ content: string, quotes: number, indent: number }} 去掉前缀后的内容、
 *   块引用层数与前缀总宽度
 */
function stripContainers(line) {
  let rest = line
  let quotes = 0
  let indent = 0
  for (;;) {
    const quote = QUOTE_PREFIX.exec(rest)
    if (quote !== null) {
      rest = rest.slice(quote[0].length)
      quotes += 1
      indent += quote[0].length
      continue
    }
    const list = LIST_PREFIX.exec(rest)
    if (list !== null) {
      rest = rest.slice(list[0].length)
      indent += list[0].length
      continue
    }
    return { content: rest, quotes, indent }
  }
}

/**
 * 判断围栏里的一行是不是关闭行。
 *
 * 围栏内是字面量，开栏后不能再剥行首的 `>` / `- `：代码里的 `> ``` ` / `- ``` `
 * 不是容器标记，误剥会把真正的代码行当成关闭行。块引用是每行都带的容器结构，
 * 按开栏时的层数剥掉；列表续行用缩进而不是重复列表标记，所以只按开栏时的前缀
 * 宽度退到内容起始列。
 *
 * @param {string} line - 原始行
 * @param {{ char: string, length: number, quotes: number, indent: number }} fence -
 *   开栏时的字符、长度与容器信息
 * @returns {boolean | null} 是否关闭；`null` 表示块引用容器已经不在这一行上
 */
function closesFence(line, fence) {
  let rest = line
  let stripped = 0
  for (let index = 0; index < fence.quotes; index += 1) {
    const quote = QUOTE_PREFIX.exec(rest)
    if (quote === null) return null
    rest = rest.slice(quote[0].length)
    stripped += quote[0].length
  }
  const spaces = /^ */.exec(rest)[0].length
  rest = rest.slice(Math.min(spaces, Math.max(0, fence.indent - stripped)))
  const marker = FENCE_MARKER.exec(rest)
  if (marker === null) return false
  return marker[1][0] === fence.char && marker[1].length >= fence.length && marker[2].trim() === ''
}

/**
 * 把 Markdown 源码里的软换行改成硬换行。
 *
 * leader 任务正文经常逐行写「做什么 / 边界 / 验收」，交给 Markdown 会被软换行
 * 折成一段。逐行补两个尾随空格后，GFM 把换行渲染成 `<br>`，逐行结构与行内
 * Markdown（粗体、行内代码、链接）可以同时成立。
 *
 * 围栏代码块与缩进代码块内的换行是代码内容，不能补空格；空行本来就是段落边界，
 * 也不需要补。围栏按开栏字符与长度配对，避免把代码块里的 ``` 当成结束；围栏在
 * 块引用或列表里时先剥掉容器前缀再判断是否开栏，关闭行则按开栏时的容器缩进比对。
 *
 * @param {string} text - Markdown 源码
 * @returns {string} 软换行已改成硬换行的源码
 */
export function hardBreakMarkdown(text) {
  if (typeof text !== 'string' || text === '') return ''
  const lines = text.split('\n')
  const parsed = lines.map(stripContainers)
  let fence = null
  return lines.map((line, index) => {
    const { content } = parsed[index]
    if (fence !== null) {
      const closed = closesFence(line, fence)
      // 代码内容原样返回；关闭行也原样返回，但要恢复「不在围栏里」的状态。
      if (closed !== null) {
        if (closed) fence = null
        return line
      }
      // 块引用容器已结束，围栏跟着结束；这一行按普通正文继续判断。
      fence = null
    }
    const marker = FENCE_MARKER.exec(content)
    if (marker !== null) {
      fence = { char: marker[1][0], length: marker[1].length, quotes: parsed[index].quotes, indent: parsed[index].indent }
      return line
    }
    // 最后一行、空行与后随空行的行不需要硬换行：段落边界已经由空行表达。
    if (index === lines.length - 1 || content.trim() === '' || parsed[index + 1].content.trim() === '') return line
    if (/^(?: {4}|\t)/.test(content)) return line
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
