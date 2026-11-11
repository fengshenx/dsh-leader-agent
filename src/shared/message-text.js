/**
 * 消息内容块的纯文本提取与渲染格式判定。
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

/**
 * 决定一段正文按 Markdown 还是纯文本渲染。
 *
 * 只有三种情形判 Markdown：整段没有换行（单行不存在折段，行内语法照常渲染）、
 * 含空行（`\n\n` 是段落边界）、含行首块级标记（标题、列表、围栏、表格、引用）。
 * 其余多行正文交给 Markdown 会被软换行折成一段——那是逐行协议字段的坑。
 *
 * leader 任务气泡不走这条判据：它与 assistant 内容同套 Markdown（`Markdown`
 * 包装的基线 `MarkdownText`，`compact` 变体），原文直接交给渲染器、单换行按
 * Markdown 合并。这里只服务 worker 回报的 `report` 判据；失败原因在
 * `workerReportFormat` 里提前走纯文本，旧回报回退的协议行也保持纯文本。
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
