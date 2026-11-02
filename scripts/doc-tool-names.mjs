/**
 * 注入给会话的文档里，反引号工具名的存在性判定。
 *
 * 判定只看形状：反引号里是 `snake_case` 就按工具名比对。不按「同行有没有调/用」
 * 过滤——工具清单那种整块表格（`playbooks/program.md` 的「协调者动作与工具」）
 * 每行都没有这些字，过滤会漏掉最该守的几行。本仓代码是 JS，字段与变量都写
 * camelCase，文档里 `snake_case` 的反引号内容实际全是工具名。
 *
 * 读盘与报数在 `verify-doc-tool-names.mjs`。
 */

const INLINE_CODE = /`([^`\n]+)`/g

/** 会进会话提示词的文档：根目录两篇，加上 `PROMPT_SKILLS_DIR` 下全部 Markdown。 */
export const PROMPT_DOCS = Object.freeze(['SLOTS.md', 'COORDINATOR.md'])
export const PROMPT_SKILLS_DIR = 'skills'

/** 至少一个下划线，才可能是工具名；文件名、命令与 camelCase 字段都不命中。 */
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/

/**
 * 找出文档里引用了、但不在已注册集合中的工具名。
 *
 * 围栏代码块整段跳过：里面的反引号是示例代码，不是文档在让会话去调工具。
 *
 * @param {string} text - 文档全文
 * @param {ReadonlySet<string>} known - 已注册的工具名
 * @returns {{line: number, name: string}[]} 违规引用，空数组表示全部存在
 */
export function unknownToolNames(text, known) {
  const violations = []
  let inFence = false
  text.split('\n').forEach((content, index) => {
    if (content.trimStart().startsWith('```')) {
      inFence = !inFence
      return
    }
    if (inFence) return
    for (const [, name] of content.matchAll(INLINE_CODE)) {
      if (SNAKE_CASE.test(name) && !known.has(name)) {
        violations.push({ line: index + 1, name })
      }
    }
  })
  return violations
}
