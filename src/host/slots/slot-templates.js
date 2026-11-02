/**
 * 项目角色槽位的配置解析。
 *
 * 槽位配置放在项目目录下的 `SLOTS.md`：文件顶部用 YAML frontmatter 的
 * `slots:` 声明每个槽位的显示名，正文按 `## <槽位名>` 分节，是该槽位角色的
 * 方法与人设。协调者会话通过卡片把执行会话绑到某个槽位，被绑会话的每一轮
 * turn 都会注入对应槽位的正文。
 *
 * 槽位名是机器标识（小写 ASCII），显示名是给人看的：`label` 只进入界面，不进
 * 卡片 `slots` 的键、注入文本与反查索引。客户端经项目远程通道取这份显示名字典
 * （`src/host/projects/remote.js` 的 `projectSlots`）。
 *
 * 本模块**只读不写** `SLOTS.md`——用户与协调者用常规的 Write/Edit 工具维护它。
 *
 * @module dsh-leader-kit/host/slots/slot-templates
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../../shared/frontmatter.js'

/** 槽位配置文件名，位于项目目录下。 */
export const SLOT_TEMPLATE_FILE = 'SLOTS.md'

/**
 * 槽位名的合法形态。
 *
 * 槽位名是**机器标识**：`SLOTS.md` 的分节名、卡片 `slots` 的 JSON 键、槽位
 * 注入的反查键都用它。界面上的显示名不在这一层——项目在 frontmatter 的
 * `slots:` 下声明，没声明时由 client 回落 locale 字典（`src/client/locales.js`）。
 * 限制为小写 ASCII，保证同一份配置在任何语言环境下都是同一个键。
 */
const SLOT_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/

/** 显示名的长度上限。它只进界面，不需要容纳长句。 */
const MAX_SLOT_LABEL_LENGTH = 64

/**
 * 判断槽位名是否合法。
 *
 * 卡片工具与 `SLOTS.md` 解析共用这一条规则：两边对合法名的口径必须一致，
 * 否则卡片上绑了一个名字、解析器却整节忽略，注入静默变成空串。
 *
 * @param {unknown} name - 候选槽位名
 * @returns {boolean} 是否合法
 */
export function isValidSlotName(name) {
  return typeof name === 'string' && SLOT_NAME_PATTERN.test(name)
}

/**
 * 零合法槽位时回落的默认槽位名。
 *
 * 默认三角色 discuss/dev/review 对应讨论、实现、审查三类职责，覆盖一次交付的
 * 完整链路。回落而非留空，是为了让没写 `SLOTS.md` 的项目仍有一份可用的槽位骨架。
 */
export const DEFAULT_SLOT_NAMES = Object.freeze(['discuss', 'dev', 'review'])

/**
 * 从 frontmatter 的 `slots` 字段读显示名。
 *
 * 只认一层嵌套（`slots.<槽位名>.label`）。非法槽位名、非对象条目、空值与超长值
 * 都跳过——按未声明处理，界面回落 locale 字典或槽位名。
 *
 * @param {unknown} slots - frontmatter 的 `slots` 值
 * @returns {Map<string, string>} 槽位名到显示名
 */
function readSlotLabels(slots) {
  const labels = new Map()
  if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) return labels
  for (const [name, entry] of Object.entries(slots)) {
    if (!isValidSlotName(name)) continue
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const label = entry.label
    if (typeof label === 'string' && label !== '' && label.length <= MAX_SLOT_LABEL_LENGTH) {
      labels.set(name, label)
    }
  }
  return labels
}

/**
 * 解析 `SLOTS.md` 内容。
 *
 * 显示名读 frontmatter 的 `slots.<槽位名>.label`；正文分节规则：行首
 * `## <名字>` 开启一个新槽位节，其后的行归属该节。同名槽位先见为准（后面的
 * 同名节整节忽略），非法名开启的节整节忽略。空正文是合法条目，`body` 为空串
 * ——「槽位存在但没写内容」与「槽位不存在」是两回事。frontmatter 里声明了但
 * 正文没有节的槽位不成立：正文才是槽位存在的依据。
 *
 * @param {string} content - 文件内容
 * @returns {Map<string, { label?: string, body: string }>} 槽位名到显示名与正文
 */
export function parseSlotTemplates(content) {
  const slots = new Map()
  if (typeof content !== 'string') return slots
  const { data, body } = parseFrontmatter(content)
  const labels = readSlotLabels(data.slots)
  /** @type {{ name: string, lines: string[] }[]} 已开启的合法节 */
  const sections = []
  /** @type {{ name: string, lines: string[] } | undefined} 当前正在收集的节 */
  let current
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line)
    if (heading !== null) {
      const name = heading[1].trim()
      if (!isValidSlotName(name) || slots.has(name)) {
        // 非法名或重复名：该节整体不属于任何槽位，正文不得归到上一节。
        current = undefined
        continue
      }
      current = { name, lines: [] }
      slots.set(name, { body: '' })
      sections.push(current)
      continue
    }
    if (current === undefined) continue
    current.lines.push(line)
  }
  for (const section of sections) {
    const label = labels.get(section.name)
    slots.set(section.name, {
      ...label === undefined ? {} : { label },
      body: section.lines.join('\n').trim(),
    })
  }
  return slots
}

/**
 * 读取项目目录下的槽位配置。
 *
 * 文件缺失、读失败或零合法条目时回落到默认槽位名（正文为空、无显示名）。回落是
 * 刻意的：槽位配置缺失是常态，不该让整个插件报错。
 *
 * @param {string} directory - 项目目录绝对路径
 * @returns {Map<string, { label?: string, body: string }>} 槽位名到配置
 */
export function loadSlotTemplates(directory) {
  const fallback = new Map()
  for (const name of DEFAULT_SLOT_NAMES) fallback.set(name, { body: '' })
  if (typeof directory !== 'string' || directory === '') return fallback
  let content
  try {
    content = readFileSync(join(directory, SLOT_TEMPLATE_FILE), 'utf8')
  } catch (error) {
    return fallback
  }
  const parsed = parseSlotTemplates(content)
  if (parsed.size === 0) return fallback
  return parsed
}
