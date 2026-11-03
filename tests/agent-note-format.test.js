import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { checkLinks, checkNote } from '../scripts/agent-note-format.mjs'

const PATH = 'implemented/feature/2026-11-02-sample-note.md'

const IMPLEMENTED_TEXT =
  '# 示例标题\n\n## 背景\n\n为什么要有这篇。\n\n## 决策\n\n做了什么。\n\n## 边界\n\n## 验证\n\n- 用例\n'

/** 一份合规模板；用例只改要测的那一处。 */
function violationsOf({ path = PATH, text = IMPLEMENTED_TEXT } = {}) {
  return checkNote(path, text)
}

test('合规模板不报违规', () => {
  assert.deepEqual(violationsOf(), [])
})

test('路径必须是 {lifecycle}/{class}/文件名.md', () => {
  assert.match(violationsOf({ path: '2026-11-02-sample-note.md' }).join('\n'), /路径必须是/)
  assert.match(violationsOf({ path: 'implemented/2026-11-02-sample-note.md' }).join('\n'), /路径必须是/)
  assert.match(
    violationsOf({ path: 'implemented/feature/deep/2026-11-02-sample-note.md' }).join('\n'),
    /路径必须是/,
  )
})

test('lifecycle 与 class 只认闭集', () => {
  assert.match(
    violationsOf({ path: 'superseded/feature/2026-11-02-sample-note.md' }).join('\n'),
    /未知 lifecycle `superseded`/,
  )
  assert.match(
    violationsOf({ path: 'implemented/refactor/2026-11-02-sample-note.md' }).join('\n'),
    /未知 class `refactor`/,
  )
})

test('文件名必须是 YYYY-MM-DD-英文小写标题', () => {
  for (const name of ['sample-note.md', '2026-11-02-示例.md', '2026-11-02-Sample-Note.md', '2026-11-02.md']) {
    assert.match(
      violationsOf({ path: `implemented/feature/${name}` }).join('\n'),
      /文件名必须是/,
      `${name} 应被判违规`,
    )
  }
})

test('文件名日期必须真实存在', () => {
  assert.match(
    violationsOf({ path: 'implemented/feature/2026-13-01-sample-note.md' }).join('\n'),
    /日期 2026-13-01 不存在/,
  )
  assert.deepEqual(violationsOf({ path: 'implemented/feature/2028-02-29-sample-note.md' }), [])
})

test('H1 必须是第一行且只有一个', () => {
  assert.match(violationsOf({ text: '前言\n\n# 示例标题\n\n## 背景\n\n## 决策\n' }).join('\n'), /H1 必须是文件第一行/)
  assert.match(violationsOf({ text: '# 甲\n\n## 背景\n\n## 决策\n\n# 乙\n' }).join('\n'), /H1 只能有一个/)
  assert.match(violationsOf({ text: '## 背景\n\n## 决策\n' }).join('\n'), /缺少 H1 标题/)
})

test('第一节必须是背景', () => {
  assert.match(violationsOf({ text: '# 甲\n\n## 现象\n\n## 决策\n' }).join('\n'), /第一节必须是 `## 背景`/)
})

test('implemented 与 archived 必须有决策节', () => {
  const text = '# 甲\n\n## 背景\n\n## 验证\n'
  assert.match(violationsOf({ text }).join('\n'), /缺少 `## 决策` 节/)
  assert.match(
    violationsOf({ path: 'archived/feature/2026-11-02-sample-note.md', text }).join('\n'),
    /缺少 `## 决策` 节/,
  )
})

test('proposed 要提案与验收标准，不要求决策节', () => {
  const path = 'proposed/feature/2026-11-02-sample-note.md'
  const text = '# 甲\n\n## 背景\n\n## 提案\n\n打算怎么做。\n\n## 验收标准\n\n## 风险\n'
  assert.deepEqual(violationsOf({ path, text }), [])
  assert.match(
    violationsOf({ path, text: '# 甲\n\n## 背景\n\n## 提案\n' }).join('\n'),
    /缺少 `## 验收标准` 节（proposed 要求）/,
  )
})

test('rejected 要提案与否决理由', () => {
  const path = 'rejected/architecture/2026-11-02-sample-note.md'
  const text = '# 甲\n\n## 背景\n\n## 提案\n\n## 否决理由\n'
  assert.deepEqual(violationsOf({ path, text }), [])
  assert.match(
    violationsOf({ path, text: '# 甲\n\n## 背景\n\n## 提案\n' }).join('\n'),
    /缺少 `## 否决理由` 节（rejected 要求）/,
  )
})

test('同名的节不能出现两次', () => {
  assert.match(violationsOf({ text: '# 甲\n\n## 背景\n\n## 决策\n\n## 背景\n' }).join('\n'), /`## 背景` 出现了 2 次/)
})

test('围栏里的 # 是示例，不算结构', () => {
  const text = '# 甲\n\n## 背景\n\n```markdown\n# 不是标题\n## 也不是节\n```\n\n## 决策\n'
  assert.deepEqual(violationsOf({ text }), [])
})

test('笔记间链接必须可达', () => {
  const text = '# 甲\n\n## 背景\n\n见[另一篇](../architecture/2026-11-02-other.md)。\n\n## 决策\n'
  assert.deepEqual(checkLinks(text, () => true), [])
  assert.match(checkLinks(text, () => false).join('\n'), /链接目标不存在：`\.\.\/architecture\/2026-11-02-other\.md`/)
})

test('外链、纯锚点与非 Markdown 目标不判', () => {
  const text = '# 甲\n\n## 背景\n\n[外链](https://example.com/a.md) [锚点](#决策) [目录](../docs/architecture)\n\n## 决策\n'
  assert.deepEqual(checkLinks(text, () => false), [])
})

test('围栏里的链接示例不算', () => {
  const text = '# 甲\n\n## 背景\n\n```markdown\n[示例](./missing.md)\n```\n\n## 决策\n'
  assert.deepEqual(checkLinks(text, () => false), [])
})

test('仓库现有笔记全部合规（含链接可达）', () => {
  const dir = new URL('../.agents/notes/', import.meta.url)
  const paths = readdirSync(dir, { recursive: true })
    .map(entry => String(entry).split('\\').join('/'))
    .filter(path => path.endsWith('.md') && path !== 'README.md' && path !== 'AGENTS.md')
    .sort()
  assert.ok(paths.length > 0, '.agents/notes 下没有笔记')
  const bad = paths.flatMap(path => {
    const file = join(dir.pathname, path)
    const text = readFileSync(file, 'utf8')
    const isReachable = url => existsSync(resolve(dirname(file), url.split('#')[0]))
    return [...checkNote(path, text), ...checkLinks(text, isReachable)].map(violation => `${path}: ${violation}`)
  })
  assert.deepEqual(bad, [])
})
