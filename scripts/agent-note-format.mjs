/**
 * Agent Note 的结构判定：路径双轴（lifecycle × class）、文件名、头部块与 Status、
 * 首节 `## Problem`、按 lifecycle 的必需节、implemented 禁提案期节名、
 * `## Alternatives considered`、legacy marker、唯一 H1、节名不重复、笔记间链接可达。
 * 正文写什么不在这层判——那要人读。
 *
 * 格式来源：宿主 `scripts/verify-agent-note-format.ts` 与 `.agents/notes/README.md`。
 */

const NAME = /^(\d{4})-(\d{2})-(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/

/** 第 1 行必须是 `# Agent Note: ` 加非空标题。 */
const TITLE = /^# Agent Note: \S/

const PROBLEM = '## Problem'
const ALTERNATIVES = '## Alternatives considered'

/** 状态轴。`archived` 只作历史记录，沿用 implemented 的 Status 与骨架。 */
export const LIFECYCLES = ['proposed', 'implemented', 'rejected', 'archived']

/** 类型轴。归属口径见 AGENTS.md 的「提交与 PR」一节。 */
export const CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing']

/** 路径与 `Status:` 双写，由门禁交叉校验。 */
const STATUS = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — .+$/,
  archived: /^Status: implemented$/,
}

/** 按 lifecycle 的必需节，`## ` 开头、精确匹配。 */
const REQUIRED_SECTIONS = {
  proposed: ['## Proposal', '## Acceptance criteria', '## Risks'],
  implemented: ['## Decision', '## Consequences'],
  rejected: ['## Proposal'],
  archived: ['## Decision', '## Consequences'],
}

/** implemented / archived 里的提案期节名。 */
const BANNED_IMPLEMENTED = /^## (?:Proposal\b|Plan\b|Migration plan\b|Acceptance criteria\b)/i

/** 宿主已退役的占位 marker。 */
const LEGACY_MARKERS = [
  'XXX: legacy ADR/RFC body format',
  'XXX: legacy ADR/Agent Note body format',
]

/** 围栏里的 `#` 是示例，不是文档结构。缩进三格以内都算围栏——列表项里也常写。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/

function proseLines(text) {
  let fence = null
  const kept = []
  for (const line of text.split('\n')) {
    const matched = FENCE.exec(line)
    if (matched !== null) {
      const marker = matched[1]
      if (fence === null) fence = marker
      // 闭合围栏要同字符且不短于开启的：4 个反引号块里嵌的 3 个反引号是内容
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (fence === null) kept.push(line)
  }
  return kept
}

/** `2026-13-01` 这种要认出来，不能靠正则形状就算过。 */
function isRealDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  )
}

/**
 * @param {string} relPath 相对 `.agents/notes/` 的 POSIX 路径
 * @param {string} text 文件全文
 * @returns {string[]} 违规项，空数组表示合规
 */
export function checkNote(relPath, text) {
  const violations = []

  const segments = relPath.split('/')
  const name = segments.at(-1) ?? ''
  const lifecycle = segments.length === 3 ? segments[0] : null
  const klass = segments.length === 3 ? segments[1] : null

  if (segments.length !== 3) {
    violations.push(`路径必须是 \`{lifecycle}/{class}/文件名.md\`（现在是 \`${relPath}\`）`)
  } else {
    if (!LIFECYCLES.includes(lifecycle)) {
      violations.push(`未知 lifecycle \`${lifecycle}\`，只认 ${LIFECYCLES.join(' / ')}`)
    }
    if (!CLASSES.includes(klass)) {
      violations.push(`未知 class \`${klass}\`，只认 ${CLASSES.join(' / ')}`)
    }
  }

  const matched = NAME.exec(name)
  if (matched === null) {
    violations.push('文件名必须是 `YYYY-MM-DD-<english-slug>.md`：日期在前，标题用英文小写与连字符')
  } else if (!isRealDate(matched[1], matched[2], matched[3])) {
    violations.push(`文件名日期 ${matched[1]}-${matched[2]}-${matched[3]} 不存在`)
  }

  const lines = proseLines(text)
  const raw = text.split('\n')

  if (!TITLE.test(raw[0] ?? '')) {
    violations.push('第 1 行必须是 `# Agent Note: <标题>`，标题不能为空')
  }
  if (raw[1] !== '') violations.push('第 2 行必须是空行')
  const status = STATUS[lifecycle]
  if (status !== undefined && !status.test(raw[2] ?? '')) {
    violations.push(`第 3 行必须匹配 ${lifecycle} 的 Status 形态（${status}）`)
  }
  if (raw[3] !== '') violations.push('第 4 行必须是空行')

  const statusLines = lines.filter(line => line.startsWith('Status:'))
  if (statusLines.length !== 1 || statusLines[0] !== raw[2]) {
    violations.push('`Status:` 行必须只出现在第 3 行，且全文件只有这一条')
  }

  const titles = lines.filter(line => /^# \S/.test(line))
  if (titles.length === 0) {
    violations.push('缺少 H1 标题（第 1 行应为 `# Agent Note: <标题>`）')
  } else {
    const firstContent = lines.find(line => line.trim() !== '')
    if (titles[0] !== firstContent) violations.push('H1 必须是文件第一行，前面不能有正文')
    if (titles.length > 1) violations.push(`H1 只能有一个，现在有 ${titles.length} 个`)
  }

  const h2s = lines.filter(line => line.startsWith('## ')).map(line => line.trimEnd())
  if (h2s.length === 0) {
    violations.push(`正文没有分节（首节应为 \`${PROBLEM}\`）`)
  } else if (h2s[0] !== PROBLEM) {
    violations.push(`第一节必须是 \`${PROBLEM}\`（现在是 \`${h2s[0]}\`）`)
  }

  for (const required of REQUIRED_SECTIONS[lifecycle] ?? REQUIRED_SECTIONS.implemented) {
    if (!h2s.includes(required)) violations.push(`缺少 \`${required}\` 节（${lifecycle ?? 'implemented'} 要求）`)
  }
  if (lifecycle === 'implemented' || lifecycle === 'archived') {
    for (const h2 of h2s.filter(heading => BANNED_IMPLEMENTED.test(heading))) {
      violations.push(`\`${h2}\` 是提案期节名；implemented / archived 用现在时，把内容折进 Decision / Consequences / Testing`)
    }
  }
  if (!h2s.includes(ALTERNATIVES)) {
    violations.push(`缺少 \`${ALTERNATIVES}\` 节（每个 lifecycle 都要求；不能用注释代替）`)
  }
  for (const marker of LEGACY_MARKERS) {
    if (lines.some(line => line.includes(marker))) {
      violations.push(`出现已退役的 legacy marker：\`${marker}\``)
    }
  }

  const sectionNames = h2s.map(line => line.slice(3).trim())
  for (const section of new Set(sectionNames)) {
    const count = sectionNames.filter(candidate => candidate === section).length
    if (count > 1) violations.push(`\`## ${section}\` 出现了 ${count} 次`)
  }

  return violations
}

/**
 * 笔记里的 Markdown 相对链接必须落到存在的文件上：迁移目录时漏改的链接靠这条兜底。
 * 路径解析交给调用方（它知道笔记的绝对位置），本函数只负责遍历与报错。
 * @param {string} text 文件全文
 * @param {(url: string) => boolean} isReachable 链接目标是否存在
 * @returns {string[]} 违规项
 */
export function checkLinks(text, isReachable) {
  const violations = []

  for (const line of proseLines(text)) {
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const url = match[1]
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#')) continue
      if (!url.split('#')[0].endsWith('.md')) continue
      if (!isReachable(url)) violations.push(`链接目标不存在：\`${url}\``)
    }
  }

  return violations
}
