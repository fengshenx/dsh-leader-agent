/**
 * 按字符上限截断并标注。
 *
 * worker 的回报与 `read_worker_session` 的转录都要进 leader 的上下文，不设上限
 * 会挤掉它自己的工作记忆；但静默截断会让 leader 把「半截结论」当成全文。这里统一
 * 两件事：截断点按码点边界退让（按 UTF-16 码元切会把代理对劈开，渲染成 U+FFFD），
 * 标记里写出原长与调用方给的下一步提示（读者知道这不是全文，也知道去哪儿取）。
 *
 * 标记计入上限：`limit` 是硬上限，正文与标记一起落在里面。
 *
 * @module dsh-leader-agent/shared/truncate
 */

/**
 * 把正文压到 `limit` 个 UTF-16 码元以内，超出时追加截断标记。
 *
 * `limit` 小到装不下标记时（只可能是调用方传错）退化成只留省略号，仍不超限。
 *
 * @param {string} text - 原文
 * @param {number} limit - 上限（UTF-16 码元数）
 * @param {string} [note] - 接在字符数之后的下一步提示，须自带分隔符（通常以 `；` 开头）
 * @returns {string} 截断后的文本
 */
export function clipText(text, limit, note = '') {
  if (typeof text !== 'string' || text === '') return ''
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  const marker = `…（已截断，原长 ${text.length} 字符${note}）`
  const room = limit - marker.length
  if (room < 1) return `${text.slice(0, codePointEnd(text, limit - 1))}…`
  return `${text.slice(0, codePointEnd(text, room))}${marker}`
}

/**
 * 取一个不会劈开代理对的切点。
 *
 * 只保证码点完整，不切字素簇：丢掉组合标记只影响重音，不是乱码。
 *
 * @param {string} text - 原文
 * @param {number} end - 期望切点（码元数）
 * @returns {number} 退让到码点边界后的切点
 */
function codePointEnd(text, end) {
  if (end <= 0) return 0
  const last = text.charCodeAt(end - 1)
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end
}
