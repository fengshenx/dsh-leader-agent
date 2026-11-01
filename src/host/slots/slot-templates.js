/**
 * 项目角色槽位的配置解析。
 *
 * 槽位配置放在项目目录下的 `SLOTS.md`：文件按 `## <槽位名>` 分节，
 * 正文是该槽位角色的方法与人设。协调者会话通过卡片把执行会话绑到某个槽位，
 * 被绑会话的每一轮 turn 都会注入对应槽位的正文。
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
 * 槽位名会进入卡片字段与提示词文本，限制为小写字母、数字、下划线与连字符，
 * 避免出现需要转义的字符。
 */
const SLOT_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/

/**
 * 零合法槽位时回落的默认槽位名。
 *
 * 默认三角色 discuss/dev/review 对应讨论、实现、审查三类职责，覆盖一次交付的
 * 完整链路。回落而非留空，是为了让没写 `SLOTS.md` 的项目仍有一份可用的槽位骨架。
 */
export const DEFAULT_SLOT_NAMES = Object.freeze(['discuss', 'dev', 'review'])

/**
 * 解析 `SLOTS.md` 内容。
 *
 * 分节规则：行首 `## <名字>` 开启一个新槽位节，其后的正文归属该节。同名槽位
 * 先见为准（后面的同名节整节忽略），非法名开启的节整节忽略。空正文是合法条目，
 * 值为空串——「槽位存在但没写内容」与「槽位不存在」是两回事。
 *
 * @param {string} content - 文件内容
 * @returns {Map<string, string>} 槽位名到正文
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
      if (!SLOT_NAME_PATTERN.test(name) || slots.has(name)) {
        // 非法名或重复名：该节整体不属于任何槽位，正文不得归到上一节。
        current = undefined
        continue
      }
      current = { name, lines: [] }
      slots.set(name, '')
      sections.push(current)
      continue
    }
    if (current === undefined) continue
    current.lines.push(line)
  }
  for (const section of sections) {
    slots.set(section.name, section.lines.join('\n').trim())
  }
  return slots
}

/**
 * 读取项目目录下的槽位配置。
 *
 * 文件缺失、读失败或零合法条目时回落到默认槽位名（正文为空）。回落是刻意的：
 * 槽位配置缺失是常态，不该让整个插件报错。
 *
 * @param {string} directory - 项目目录绝对路径
 * @returns {Map<string, string>} 槽位名到正文；默认槽位正文为空
 */
export function loadSlotTemplates(directory) {
  const fallback = new Map()
  for (const name of DEFAULT_SLOT_NAMES) fallback.set(name, '')
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
