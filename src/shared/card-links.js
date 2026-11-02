/**
 * 卡片链接条目的规范化与校验。
 *
 * 浏览器侧的编辑态与宿主侧的远程写通道共用同一份判定：保存前的 trim、空行
 * 丢弃与 URL 校验在两端必须一致，否则界面看着合法的内容会在宿主侧被拒，或
 * 反过来把非法 URL 落盘。
 *
 * **三条写入路径都只认 http(s)**：卡片工具（`create_card` / `update_card`）、
 * 浏览器编辑态与 `updateCardLinks` 写通道共用这里的判定，非 http(s) 在落盘前
 * 拒绝。渲染层仍要兜**存量卡**：校验上线前写进去的数据可能带 `javascript:` 等
 * 非 http(s) scheme。
 *
 * 写入边界用 `new URL(value).href` 归一化后再落盘：`http:example.com`、
 * `https:/example.com` 与内嵌换行的写法都会被存成规范形式，不会原样进存储。
 * 校验与归一化是同一个函数，避免「判定的形态」与「落盘的形态」各是一套规则。
 *
 * @module dsh-leader-kit/shared/card-links
 */

/**
 * 把候选值归一化成 http(s) 绝对地址。
 *
 * WHATWG URL 接受 `http:example.com` 这类省略 `//` 的写法，也会去掉地址里的
 * 制表/换行；这里接受它们并返回 `href`，由写入边界落盘规范形式。相对路径、
 * 非 http(s) scheme 与非字符串一律返回 null。
 *
 * @param {unknown} value - 候选值
 * @returns {string | null} 规范形式；不是 http(s) 绝对地址时为 null
 */
export function normalizeHttpUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    // 不是绝对 URL（含空串与相对路径）一律不算。
    return null
  }
}

/**
 * URL 是否为 http(s) 绝对地址。
 *
 * 与 {@link normalizeHttpUrl} 同一判定：能归一化成 http(s) 就算。
 *
 * @param {unknown} value - 候选值
 * @returns {boolean} 是否为 http(s)
 */
export function isHttpUrl(value) {
  return normalizeHttpUrl(value) !== null
}

/**
 * 规范化链接草稿。
 *
 * 编辑态的语义：label、url、purpose 全部 trim；整行都空的条目丢弃（新增行没
 * 填完不算错误），只填了 url / purpose 却漏 label 的则报错——静默丢掉用户输入
 * 比拦住他更糟；url / purpose 为空即删字段，不落空串；url 有值但不是 http(s)
 * 时整批拒绝，并点名是哪个标签。http(s) 地址按 URL 标准归一化后落盘。
 *
 * 条目 `id` 原样保留，缺 id 的由调用方补：宿主侧写通道需要 id 作为卡片链接的
 * 稳定标识，浏览器侧编辑态只需它当渲染 key。重复的 id 会被丢掉（工具不查重，
 * 模型可能给两张链接同一个 id；留着会让编辑态改一行动两行）。
 *
 * @param {unknown} links - 链接草稿
 * @returns {{ links: object[] } | { error: string }} 规范化结果或错误说明
 */
export function normalizeLinkDrafts(links) {
  if (!Array.isArray(links)) return { error: '链接必须是数组' }
  const normalized = []
  const seenIds = new Set()
  for (const entry of links) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: '链接条目必须是对象' }
    }
    for (const field of ['id', 'label', 'url', 'purpose']) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string') {
        return { error: `链接条目的 ${field} 必须是字符串` }
      }
    }
    const label = (entry.label ?? '').trim()
    const rawUrl = (entry.url ?? '').trim()
    const purpose = (entry.purpose ?? '').trim()
    if (label === '') {
      if (rawUrl === '' && purpose === '') continue
      return { error: `有一条链接只填了${rawUrl === '' ? '用途' : ' URL'}，标签不能为空` }
    }
    let url = ''
    if (rawUrl !== '') {
      const normalizedUrl = normalizeHttpUrl(rawUrl)
      if (normalizedUrl === null) {
        return { error: `「${label}」的链接 URL 必须是 http(s) 绝对地址，例如 https://example.com/…` }
      }
      url = normalizedUrl
    }
    const id = typeof entry.id === 'string' && entry.id !== '' && !seenIds.has(entry.id)
      ? entry.id
      : undefined
    if (id !== undefined) seenIds.add(id)
    normalized.push({
      ...id === undefined ? {} : { id },
      label,
      ...url === '' ? {} : { url },
      ...purpose === '' ? {} : { purpose },
    })
  }
  return { links: normalized }
}
