/**
 * Agent Note 的结构判定：文件名、唯一 H1、首节必须是背景、必须有决策节、节名不重复。
 * 正文写什么不在这层判——那要人读。
 */

const NAME = /^(\d{4})-(\d{2})-(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/

const FIRST_SECTION = '背景'
const REQUIRED_SECTIONS = ['决策']

/** 围栏里的 `#` 是示例，不是文档结构。 */
function proseLines(text) {
  let inFence = false
  const kept = []
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (!inFence) kept.push(line)
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
 * @param {string} name 文件名（不含目录）
 * @param {string} text 文件全文
 * @returns {string[]} 违规项，空数组表示合规
 */
export function checkNote(name, text) {
  const violations = []

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
  for (const section of REQUIRED_SECTIONS) {
    if (!sections.includes(section)) violations.push(`缺少 \`## ${section}\` 节`)
  }
  for (const section of new Set(sections)) {
    const count = sections.filter(candidate => candidate === section).length
    if (count > 1) violations.push(`\`## ${section}\` 出现了 ${count} 次`)
  }

  return violations
}
