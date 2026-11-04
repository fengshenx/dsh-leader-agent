/**
 * 注入给会话的文档里，反引号工具名的存在性判定。
 *
 * 判定只看形状：反引号里是 `snake_case` 就按工具名比对。不按「同行有没有调/用」
 * 过滤——工具清单那种整块表格（`playbooks/program.md` 的「leader 动作与工具」）
 * 每行都没有这些字，过滤会漏掉最该守的几行。本仓代码是 JS，字段与变量都写
 * camelCase，文档里 `snake_case` 的反引号内容实际全是工具名。
 *
 * 读盘与报数在 `verify-doc-tool-names.mjs`。
 */

const INLINE_CODE = /`([^`\n]+)`/g

/** 会进会话提示词的文档：根目录两篇，加上 `PROMPT_SKILLS_DIRS` 下全部 Markdown。 */
export const PROMPT_DOCS = Object.freeze(['SLOTS.md', 'LEADER.md'])

/**
 * 不进会话、但会指挥人照做的维护者手册。
 *
 * 它们不在提示词里，模型不会按它去调工具，所以不能靠 `PROMPT_*` 收进来；但照着手册
 * 执行的人调的是同一套工具，写错工具名一样会在运行时才炸。
 */
export const MAINTAINER_DOCS = Object.freeze(['docs/release.md'])

/** 会进会话提示词的 skill 目录（只此一个）。 */
export const PROMPT_SKILLS_DIRS = Object.freeze(['.agents/skills'])

/** 至少一个下划线，才可能是工具名；文件名、命令与 camelCase 字段都不命中。 */
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/

/**
 * 扫一篇文档里的工具名引用，并报告没闭合的围栏。
 *
 * 围栏代码块整段跳过：里面的反引号是示例代码，不是文档在让会话去调工具。围栏
 * 不配对时不能静默——那样后半篇会整段跳过、门禁照样绿，等于给了个假的通过。
 *
 * @param {string} text - 文档全文
 * @param {ReadonlySet<string>} known - 已注册的工具名
 * @returns {{violations: {line: number, name: string}[], unclosedFence?: number}} 违规引用与未闭合围栏的起始行
 */
export function scanToolNames(text, known) {
  const violations = []
  let fenceLine
  text.split('\n').forEach((content, index) => {
    if (content.trimStart().startsWith('```')) {
      fenceLine = fenceLine === undefined ? index + 1 : undefined
      return
    }
    if (fenceLine !== undefined) return
    for (const [, name] of content.matchAll(INLINE_CODE)) {
      if (SNAKE_CASE.test(name) && !known.has(name)) {
        violations.push({ line: index + 1, name })
      }
    }
  })
  return fenceLine === undefined ? { violations } : { violations, unclosedFence: fenceLine }
}
