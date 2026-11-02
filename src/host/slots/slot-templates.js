/**
 * 项目角色槽位的配置解析。
 *
 * 槽位配置放在项目目录下的 `SLOTS.md`：文件按 `## <槽位名>` 分节，节内可选
 * `label: <显示名>` 声明界面上显示的名字，其余正文是该槽位角色的方法与人设。
 * 协调者会话通过卡片把执行会话绑到某个槽位，被绑会话的每一轮 turn 都会注入
 * 对应槽位的正文。
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

/** 槽位配置文件名，位于项目目录下。 */
export const SLOT_TEMPLATE_FILE = 'SLOTS.md'

/**
 * 槽位名的合法形态。
 *
 * 槽位名是**机器标识**：`SLOTS.md` 的分节名、卡片 `slots` 的 JSON 键、槽位
 * 注入的反查键都用它。界面上的显示名不在这一层——项目用 `label:` 声明，没声明
 * 时由 client 回落 locale 字典（`src/client/locales.js`）。限制为小写 ASCII，
 * 保证同一份配置在任何语言环境下都是同一个键。
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
 * 把一个槽位节解析成显示名与正文。
 *
 * `label:` 只在节内第一条非空行生效，取到后从正文里剥离——显示名是元信息，
 * 不该作为角色说明注入模型。空值与超长值按未声明处理，正文照常从下一行开始。
 *
 * @param {string[]} lines - 节的原始行
 * @returns {{ label?: string, body: string }} 槽位配置
 */
function slotEntryOf(lines) {
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start += 1
  /** @type {string | undefined} */
  let label
  if (start < lines.length) {
    const match = /^label:[ \t]*(.*)$/i.exec(lines[start].trim())
    if (match !== null) {
      const value = match[1].trim()
      if (value !== '' && value.length <= MAX_SLOT_LABEL_LENGTH) label = value
      start += 1
    }
  }
  return {
    ...label === undefined ? {} : { label },
    body: lines.slice(start).join('\n').trim(),
  }
}

/**
 * 解析 `SLOTS.md` 内容。
 *
 * 分节规则：行首 `## <名字>` 开启一个新槽位节，其后的行归属该节。同名槽位
 * 先见为准（后面的同名节整节忽略），非法名开启的节整节忽略。空正文是合法条目，
 * `body` 为空串——「槽位存在但没写内容」与「槽位不存在」是两回事。
 *
 * @param {string} content - 文件内容
 * @returns {Map<string, { label?: string, body: string }>} 槽位名到显示名与正文
 */
export function parseSlotTemplates(content) {
  const slots = new Map()
  if (typeof content !== 'string') return slots
  /** @type {{ name: string, lines: string[] }[]} 已开启的合法节 */
  const sections = []
  /** @type {{ name: string, lines: string[] } | undefined} 当前正在收集的节 */
  let current
  for (const line of content.split(/\r?\n/)) {
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
    slots.set(section.name, slotEntryOf(section.lines))
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
