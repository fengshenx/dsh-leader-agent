/**
 * 最小 YAML frontmatter 解析。
 *
 * 支持顶层标量与按缩进嵌套的 map（`slots:` 下按缩进挂子键），够 skill 的
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
 * 解析单行标量：去掉成对引号，保留内部内容；引号外「空格 + #」之后是行内注释。
 *
 * 注释要剥掉是因为 `label` 会原样显示在卡面 chip 上，把 `# 说明` 当名字显示是
 * 错的。引号内的 `#` 属于内容，不剥。
 *
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
  const comment = value.startsWith('#') ? 0 : value.indexOf(' #')
  return comment === -1 ? value : trim(value.slice(0, comment))
}

/**
 * 解析文件开头的 frontmatter。
 *
 * 顶层 `key:` 后没有值、但下面跟了缩进更深的子键时，解析成对象；没有子键时仍是
 * 空串（保持原标量语义）。层级由缩进决定，嵌套深度不限——`slots.dev.label`
 * 这类两层结构照常解析。
 *
 * 重复键在 YAML 里非法，这里不抛错：同名的嵌套容器合并（两段 `slots:` 各写各的
 * 槽位时，后一段不该把前一段的 label 抹掉），同名标量后者覆盖。合并里唯一的例外
 * 是**冲突**——同一路径两次给了不同的值，后者覆盖会静默丢掉前一个，这种情况记进
 * `warnings` 交给调用方决定怎么报（本仓的 SLOTS.md 读侧会告警）。
 *
 * @param {string} text - 文件全文
 * @returns {{ data: Record<string, unknown>, body: string, warnings: string[] }} frontmatter 字段、剩余正文与冲突告警
 */
export function parseFrontmatter(text) {
  const normalized = text.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) {
    return { data: {}, body: normalized, warnings: [] }
  }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) {
    return { data: {}, body: normalized, warnings: [] }
  }
  const header = normalized.slice(4, end)
  const body = normalized.slice(end + 4).replace(/^\n+/, '')
  /** @type {Record<string, unknown>} */
  const data = {}
  /** @type {string[]} */
  const warnings = []
  /**
   * 缩进栈：每层是「已确认的容器 map」与它的缩进。根层缩进为 -1。
   *
   * 容器要等第一个缩进更深的子行出现才能确认——顶层 `key:` 后面没有子键时，
   * 它仍是空串标量，不能凭空变成 `{}`。
   */
  /** @type {Array<{ indent: number, map: Record<string, unknown>, key?: string }>} */
  const stack = [{ indent: -1, map: data }]
  /**
   * 上一个没有值的键，等待后续行确认它是不是容器。
   *
   * 连所属的 map 一起记：缩进回退时下一个键可能缩进比它还浅，栈会先被弹空，
   * 那时不能再从栈顶反推这个键归哪一层。
   *
   * @type {{ key: string, indent: number, parent: Record<string, unknown> } | undefined}
   */
  let pending
  for (const line of header.split('\n')) {
    const trimmed = trim(line)
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const separator = trimmed.indexOf(':')
    if (separator <= 0) continue
    const key = trim(trimmed.slice(0, separator))
    if (key === '') continue
    const value = parseScalar(trimmed.slice(separator + 1))
    if (pending !== undefined) {
      if (indent > pending.indent) {
        const existing = pending.parent[pending.key]
        const child = existing !== null && typeof existing === 'object' ? existing : {}
        pending.parent[pending.key] = child
        stack.push({ indent: pending.indent, map: /** @type {Record<string, unknown>} */ (child), key: pending.key })
      } else {
        pending.parent[pending.key] = ''
      }
      pending = undefined
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    // 没有父级可归的缩进行（根层之外直接缩进）没有语义，忽略。
    if (indent > 0 && stack.length === 1) continue
    const container = stack[stack.length - 1].map
    if (value === '') {
      pending = { key, indent, parent: container }
      continue
    }
    const previous = container[key]
    if (typeof previous === 'string' && previous !== '' && previous !== value) {
      const path = [...stack.slice(1).map((entry) => entry.key), key].join('.')
      warnings.push(`重复键 ${path}：先「${previous}」后「${value}」，后者覆盖`)
    }
    container[key] = value
  }
  if (pending !== undefined) pending.parent[pending.key] = ''
  return { data, body, warnings }
}
