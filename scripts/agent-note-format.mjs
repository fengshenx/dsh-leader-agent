/**
 * Agent Note 的结构判定：路径双轴（lifecycle × class）、文件名、唯一 H1、
 * 首节必须是背景、按 lifecycle 要求的必需节、节名不重复、笔记间链接可达。
 * 正文写什么不在这层判——那要人读。
 */

const NAME = /^(\d{4})-(\d{2})-(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/

const FIRST_SECTION = '背景'

/** 状态轴。`archived` 只作历史记录，不再指导当前行为。 */
export const LIFECYCLES = ['proposed', 'implemented', 'rejected', 'archived']

/** 类型轴。归属口径见 AGENTS.md 的「提交与 PR」一节。 */
export const CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing']

/** 进 archived 的都是一度 implemented 的文件，归档只移动路径、不改正文。 */
const REQUIRED_SECTIONS = {
  proposed: ['提案', '验收标准'],
  implemented: ['决策'],
  rejected: ['提案', '否决理由'],
  archived: ['决策'],
}

/** 围栏里的 `#` 是示例，不是文档结构。缩进三格以内都算围栏——列表项里也常写。 */
const FENCE = /^ {0,3}(```|~~~)/

function proseLines(text) {
  let fence = null
  const kept = []
  for (const line of text.split('\n')) {
    const matched = FENCE.exec(line)
    if (matched !== null) {
      // 同种围栏才成对：三反引号块里出现的波浪线只是示例内容
      if (fence === null) fence = matched[1]
      else if (fence === matched[1]) fence = null
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
  const titles = lines.filter(line => /^# \S/.test(line))
  if (titles.length === 0) {
    violations.push('缺少 H1 标题（第一行应为 `# 标题`）')
  } else {
    const firstContent = lines.find(line => line.trim() !== '')
    if (titles[0] !== firstContent) violations.push('H1 必须是文件第一行，前面不能有正文')
    if (titles.length > 1) violations.push(`H1 只能有一个，现在有 ${titles.length} 个`)
  }

  const sections = lines.filter(line => line.startsWith('## ')).map(line => line.trimEnd().slice(3).trim())
  if (sections.length === 0) {
    violations.push(`正文没有分节（首节应为 \`## ${FIRST_SECTION}\`）`)
    return violations
  }
  if (sections[0] !== FIRST_SECTION) {
    violations.push(`第一节必须是 \`## ${FIRST_SECTION}\`（现在是 \`## ${sections[0]}\`）`)
  }
  for (const section of REQUIRED_SECTIONS[lifecycle] ?? REQUIRED_SECTIONS.implemented) {
    if (!sections.includes(section)) violations.push(`缺少 \`## ${section}\` 节（${lifecycle ?? 'implemented'} 要求）`)
  }
  for (const section of new Set(sections)) {
    const count = sections.filter(candidate => candidate === section).length
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
