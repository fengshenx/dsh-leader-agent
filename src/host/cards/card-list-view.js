/**
 * 查卡工具的列表视图。
 *
 * 模型看到的与客户端看到的是同一次工具调用的两个出口：模型读 `render` 的文本，
 * 客户端读 `presentationMeta` 的投影。列表视图只管前者——客户端要全量卡片重建
 * 看板，不能被分页与状态过滤裁掉。
 *
 * 列表口径：
 *
 * - 列表按最近更新倒序，默认只列 active，一页 20 张；
 * - 列表只给可观测事实（标题、编号、状态、id、版本、更新时间、链接标签、槽位），
 *   规格全文只在单卡查询出现——它是 leader 自述，读回不产生新信息；
 * - 规格与链接两项无论有无都显式成行：省略会让模型把「未渲染」读成
 *   「没有」，而「这张卡该补规格」「这张卡有产物链接」都会改变下一步动作；
 * - 输出有字符预算，逐卡累加，超出按卡截断并给出续页位置。
 *
 * @module dsh-leader-agent/host/cards/card-list-view
 */

/** 单页张数缺省值。 */
export const LIST_DEFAULT_LIMIT = 20
/** 单页张数上限。 */
export const LIST_MAX_LIMIT = 100
/** 列表输出的字符预算：超预算就少给几张，不整页灌进上下文。 */
export const LIST_MAX_CHARS = 6_000
/** 链接标签截断长度。 */
export const LINK_LABEL_MAX_CHARS = 32
/** 列表里最多列几个链接标签。 */
export const MAX_LISTED_LINKS = 5

/**
 * 超长字段截断并标注原长。
 *
 * @param {string} text - 原文
 * @param {number} max - 最大长度
 * @returns {string} 截断后的文本
 */
function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字符）` : text
}

/**
 * 解析查卡参数。
 *
 * 非法值直接抛错：分页参数被静默收敛成缺省值时，模型会以为翻到了下一页，
 * 实际拿到的是第一页。
 *
 * @param {object} args - 工具入参
 * @returns {{ cardId: string | undefined, status: string, scope: string, limit: number, offset: number }} 查询条件
 */
export function parseListQuery(args) {
  const input = args ?? {}
  const cardId = input.cardId
  if (cardId !== undefined && (typeof cardId !== 'string' || cardId === '')) {
    throw new Error('list_cards: cardId 必须是非空字符串')
  }
  const status = input.status === undefined || input.status === null || input.status === ''
    ? 'active'
    : input.status
  if (status !== 'active' && status !== 'done' && status !== 'archived' && status !== 'all') {
    throw new Error(`list_cards: status 非法：${String(status)}`)
  }
  // 卡片按项目归属，默认只看本项目的卡；`all` 才跨项目列全库。
  const scope = input.scope === undefined || input.scope === null || input.scope === ''
    ? 'project'
    : input.scope
  if (scope !== 'project' && scope !== 'all') {
    throw new Error(`list_cards: scope 非法：${String(scope)}`)
  }
  const limit = input.limit === undefined || input.limit === null || input.limit === ''
    ? LIST_DEFAULT_LIMIT
    : input.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new Error(`list_cards: limit 必须是正整数，收到 ${String(input.limit)}`)
  }
  const offset = input.offset === undefined || input.offset === null || input.offset === ''
    ? 0
    : input.offset
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`list_cards: offset 必须是非负整数，收到 ${String(input.offset)}`)
  }
  // 不带 cardId 时不留这个键：工具返回值要过宿主的 lossless JSON 校验，
  // 值为 undefined 的键会被判成不可无损序列化。
  return {
    ...(cardId === undefined ? {} : { cardId }),
    status,
    scope,
    limit: Math.min(limit, LIST_MAX_LIMIT),
    offset,
  }
}

/**
 * 按查询条件挑出本页卡片。
 *
 * 计数是全量口径，不随状态过滤与分页变化——尾注里的「active 3 · done 1」说的是
 * 全项目有多少，不是本页有多少。
 *
 * @param {readonly object[]} cards - 全部卡片
 * @param {{ cardId: string | undefined, status: string, limit: number, offset: number }} query - 查询条件
 * @returns {{ page: object[], total: number, counts: { active: number, done: number, archived: number } }} 本页与计数
 */
export function selectCards(cards, query) {
  // 计数是全量口径，不随状态过滤与分页变化——尾注里的「active 3 · done 1」说的是
  // 全项目有多少，不是本页有多少。一次遍历同时数三种状态。
  const counts = { active: 0, done: 0, archived: 0 }
  for (const card of cards) {
    if (card.status === 'active') counts.active += 1
    else if (card.status === 'done') counts.done += 1
    else if (card.status === 'archived') counts.archived += 1
  }
  if (query.cardId !== undefined) {
    const found = cards.filter((card) => card.id === query.cardId)
    return { page: found, total: found.length, counts }
  }
  const filtered = query.status === 'all'
    ? [...cards]
    : cards.filter((card) => card.status === query.status)
  // 最近更新在前：leader 关心的是正在动的卡，历史卡不能把当前卡挤出第一页
  const ordered = [...filtered].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
  return {
    page: ordered.slice(query.offset, query.offset + query.limit),
    total: filtered.length,
    counts,
  }
}

/**
 * 卡片标题行：编号、标题、状态、id、版本与更新时间。
 *
 * @param {object} card - 卡片
 * @returns {string} 标题行
 */
function cardHeading(card) {
  const number = card.number === undefined ? '' : `#${card.number} `
  const updated = card.updatedAt === undefined ? '未知' : new Date(card.updatedAt).toISOString()
  return `# ${number}${card.title} [${card.status}] cardId: ${card.id} revision: ${card.revision ?? 0} 更新于 ${updated}`
}

/**
 * 规格是否算数：盘上字段被手改成 null 时既不算「有」也不能抛。
 *
 * @param {object} card - 卡片
 * @returns {boolean} 有规格
 */
function hasSpec(card) {
  return typeof card.spec === 'string' && card.spec.trim().length > 0
}

/**
 * 分类行：卡面头部的只读短标签。
 *
 * 与规格、链接一样显式成行：省略会让模型把「没有分类」读成「工具不给分类」，
 * 而「这张卡该补分类」正是它会做的下一步动作。
 *
 * @param {object} card - 卡片
 * @returns {string} 分类行
 */
function renderKind(card) {
  const kind = typeof card.kind === 'string' ? card.kind.trim() : ''
  return `  kind: ${kind === '' ? '无' : kind}`
}

/**
 * 链接列表摘要：只给身份（标签），地址与用途留给单卡查询。
 *
 * @param {object} card - 卡片
 * @returns {string} 链接摘要
 */
function summarizeLinks(card) {
  if (!Array.isArray(card.links) || card.links.length === 0) return '无'
  const labels = card.links
    .slice(0, MAX_LISTED_LINKS)
    .map((link) => clip(String(link?.label ?? ''), LINK_LABEL_MAX_CHARS))
  const rest = card.links.length > labels.length ? ` …（共 ${card.links.length} 条）` : ''
  return labels.join(' · ') + rest
}

/**
 * 槽位行：谁在这张卡上干活。
 *
 * 只列卡片自己声明的槽位；空槽（没派工）不写——槽位没有会话就是没有，不必占行。
 *
 * @param {object} card - 卡片
 * @returns {string | undefined} 槽位行
 */
function renderSlots(card) {
  if (!card.slots || typeof card.slots !== 'object' || Array.isArray(card.slots)) return undefined
  const parts = Object.entries(card.slots).map(([name, binding]) => {
    const sessionId = binding?.sessionId
    return `${name}=${typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'empty'}`
  })
  return parts.length === 0 ? undefined : `  slots: ${parts.join(' ')}`
}

/**
 * 列表模式单卡摘要。
 *
 * @param {object} card - 卡片
 * @returns {string[]} 摘要行
 */
function renderCardBrief(card) {
  const lines = [cardHeading(card)]
  lines.push(renderKind(card))
  lines.push(`  spec: ${hasSpec(card) ? '有' : '无'}`)
  lines.push(`  links: ${summarizeLinks(card)}`)
  const slots = renderSlots(card)
  if (slots !== undefined) lines.push(slots)
  return lines
}

/**
 * 单卡模式：规格与链接全文。
 *
 * @param {object} card - 卡片
 * @returns {string[]} 详情行
 */
function renderCardDetail(card) {
  const lines = [cardHeading(card)]
  lines.push(renderKind(card))
  if (hasSpec(card)) {
    lines.push('  spec:', ...card.spec.split('\n').map((line) => `    ${line}`))
  }
  if (Array.isArray(card.links) && card.links.length > 0) {
    lines.push('  links:')
    for (const link of card.links) {
      const purpose = link?.purpose ? `（${link.purpose}）` : ''
      const url = link?.url ? `: ${link.url}` : ''
      lines.push(`  - ${link?.label ?? ''}${url}${purpose}`)
    }
  }
  const slots = renderSlots(card)
  if (slots !== undefined) lines.push(slots)
  return lines
}

/**
 * 渲染查卡结果。
 *
 * @param {readonly object[]} cards - 全部卡片
 * @param {{ cardId: string | undefined, status: string, scope: string, limit: number, offset: number }} query - 查询条件
 * @returns {string} 给模型看的文本
 */
export function renderCardList(cards, query) {
  if (query.cardId !== undefined) {
    const found = cards.find((card) => card.id === query.cardId)
    if (found === undefined) return `卡片不存在：cardId=${query.cardId}`
    return renderCardDetail(found).join('\n')
  }
  const { page, total, counts } = selectCards(cards, query)
  // 「项目」与「全库」是两种范围，措辞要跟着变：把全库说成「项目」会让模型
  // 以为看到的卡就是本项目的全部。
  const where = query.scope === 'all' ? '全库' : '本项目'
  if (page.length === 0) {
    // 空页有两种：范围里真的没有卡，与 offset 翻过头。后者不能说成「没有卡」，
    // 同一句里报「没有 active 卡」又列 active 5 会让 leader 误判项目无在途任务。
    if (total > 0) {
      const scope = query.status === 'all' ? `${where}共 ${total} 张` : `status=${query.status} 共 ${total} 张`
      return `offset 超出范围：${scope}，请从 offset=0 重新翻页。`
    }
    return query.status === 'all'
      ? `${where}当前没有卡片。`
      : `${where}当前没有 ${query.status} 卡（active ${counts.active} · done ${counts.done} · archived ${counts.archived}）。`
  }
  // 首行只报总张数，不报「本页 N 张」：本页张数会被字符预算截断，首行按 limit 写
  // 会与实际渲染出来的张数自相矛盾（「本页 20 张」对「只显示 11/20 张」）。
  // 实际显示了几张由尾注说。
  const header = `卡片快照（scope=${query.scope}，status=${query.status}，共 ${total} 张）：`
  const blocks = []
  let used = header.length
  for (const card of page) {
    const block = renderCardBrief(card).join('\n')
    // 逐卡累加，超预算就从这里截断（宁可少给几张，也不整页灌进上下文）
    if (blocks.length > 0 && used + block.length > LIST_MAX_CHARS) break
    blocks.push(block)
    used += block.length + 1
  }
  const notes = []
  if (blocks.length < page.length) {
    // 截断时续页只认实际渲染张数：未渲染的卡不能被当成已显示，否则照第二条 offset 翻会跳卡
    notes.push(`…（输出超过 ${LIST_MAX_CHARS} 字符上限，本页显示 ${blocks.length}/${page.length} 张，用 offset=${query.offset + blocks.length} 继续）`)
  } else {
    const shownUntil = query.offset + blocks.length
    if (shownUntil < total) {
      notes.push(`本页显示 ${blocks.length} 张，还有 ${total - shownUntil} 张未显示（offset=${shownUntil} 继续）。`)
    }
  }
  if (query.status !== 'all') {
    // 计数是全量口径，不随本页过滤变化，因此不能写成「另有」（那会被读成还有多少张没显示）
    notes.push(`${where}：active ${counts.active} · done ${counts.done} · archived ${counts.archived}，用 status 参数切换。`)
  }
  return [header, ...blocks, ...(notes.length > 0 ? ['', ...notes] : [])].join('\n')
}
