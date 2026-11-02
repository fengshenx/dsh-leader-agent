/**
 * 最小 YAML frontmatter 解析。
 *
 * 只支持 skill 需要的标量字段（name / description / whenToUse），
 * 不引入 YAML 依赖——bundle 保持零运行时依赖，宿主只需解析 Node 内置模块。
 *
 * @module dsh-leader-kit/shared/frontmatter
 */

/**
 * 去掉首尾空白。
 * @param {string} value - 原始文本
 * @returns {string} 去空白后的文本
 */
function trim(value) {
  return value.trim()
}

/**
 * 解析单行标量：去掉成对引号，保留内部内容。
 * @param {string} raw - 冒号右侧的原始文本
 * @returns {string} 解析后的标量值
 */
function parseScalar(raw) {
  const value = trim(raw)
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * 解析文件开头的 frontmatter。
 * @param {string} text - 文件全文
 * @returns {{ data: Record<string, string>, body: string }} frontmatter 字段与剩余正文
 */
export function parseFrontmatter(text) {
  const normalized = text.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) {
    return { data: {}, body: normalized }
  }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) {
    return { data: {}, body: normalized }
  }
  const header = normalized.slice(4, end)
  const body = normalized.slice(end + 4).replace(/^\n+/, '')
  /** @type {Record<string, string>} */
  const data = {}
  for (const line of header.split('\n')) {
    const trimmed = trim(line)
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf(':')
    if (separator <= 0) continue
    const key = trim(trimmed.slice(0, separator))
    if (key === '') continue
    data[key] = parseScalar(trimmed.slice(separator + 1))
  }
  return { data, body }
}
