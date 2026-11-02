/**
 * 最小 YAML frontmatter 解析。
 *
 * 支持顶层标量与一层嵌套 map（`slots:` 下按缩进挂子键），够 skill 的
 * name / description / whenToUse 与 `SLOTS.md` 的槽位元数据使用。
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
 *
 * 顶层 `key:` 后没有值、但下面跟了缩进更深的子键时，解析成对象；没有子键时仍是
 * 空串（保持原标量语义）。层级由缩进决定，嵌套深度不限——`slots.dev.label`
 * 这类两层结构照常解析。
 *
 * @param {string} text - 文件全文
 * @returns {{ data: Record<string, unknown>, body: string }} frontmatter 字段与剩余正文
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
  /** @type {Record<string, unknown>} */
  const data = {}
  /**
   * 缩进栈：每层是「已确认的容器 map」与它的缩进。根层缩进为 -1。
   *
   * 容器要等第一个缩进更深的子行出现才能确认——顶层 `key:` 后面没有子键时，
   * 它仍是空串标量，不能凭空变成 `{}`。
   */
  /** @type {Array<{ indent: number, map: Record<string, unknown> }>} */
  const stack = [{ indent: -1, map: data }]
  /** @type {string | undefined} 上一个没有值的键，等待子行确认它是不是容器 */
  let pendingKey
  let pendingIndent = -1
  for (const line of header.split('\n')) {
    const trimmed = trim(line)
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const separator = trimmed.indexOf(':')
    if (separator <= 0) continue
    const key = trim(trimmed.slice(0, separator))
    if (key === '') continue
    const value = parseScalar(trimmed.slice(separator + 1))
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    if (pendingKey !== undefined) {
      const parent = stack[stack.length - 1].map
      if (indent > pendingIndent) {
        parent[pendingKey] = {}
        stack.push({ indent: pendingIndent, map: /** @type {Record<string, unknown>} */ (parent[pendingKey]) })
      } else {
        parent[pendingKey] = ''
      }
      pendingKey = undefined
    }
    // 没有父级可归的缩进行（根层之外直接缩进）没有语义，忽略。
    if (indent > 0 && stack.length === 1) continue
    const container = stack[stack.length - 1].map
    if (value === '') {
      pendingKey = key
      pendingIndent = indent
      continue
    }
    container[key] = value
  }
  if (pendingKey !== undefined) stack[stack.length - 1].map[pendingKey] = ''
  return { data, body }
}
