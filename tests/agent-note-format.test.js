import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { checkNote } from '../scripts/agent-note-format.mjs'

const NAME = '2026-11-02-sample-note.md'

/** 一份合规模板；用例只改要测的那一处。 */
function note(overrides = {}) {
  return {
    name: overrides.name ?? NAME,
    text: overrides.text ?? '# 示例标题\n\n## 背景\n\n为什么要有这篇。\n\n## 决策\n\n做了什么。\n\n## 边界\n\n## 验证\n\n- 用例\n',
  }
}

function violationsOf(overrides) {
  const { name, text } = note(overrides)
  return checkNote(name, text)
}

test('合规模板不报违规', () => {
  assert.deepEqual(violationsOf(), [])
})

test('文件名必须是 YYYY-MM-DD-英文小写标题', () => {
  for (const name of ['sample-note.md', '2026-11-02-示例.md', '2026-11-02-Sample-Note.md', '2026-11-02.md']) {
    assert.match(violationsOf({ name }).join('\n'), /文件名必须是/, `${name} 应被判违规`)
  }
})

test('文件名日期必须真实存在', () => {
  assert.match(violationsOf({ name: '2026-13-01-sample-note.md' }).join('\n'), /日期 2026-13-01 不存在/)
  assert.deepEqual(violationsOf({ name: '2028-02-29-sample-note.md' }), [])
})

test('H1 必须是第一行且只有一个', () => {
  assert.match(violationsOf({ text: '前言\n\n# 示例标题\n\n## 背景\n\n## 决策\n' }).join('\n'), /H1 必须是文件第一行/)
  assert.match(violationsOf({ text: '# 甲\n\n## 背景\n\n## 决策\n\n# 乙\n' }).join('\n'), /H1 只能有一个/)
  assert.match(violationsOf({ text: '## 背景\n\n## 决策\n' }).join('\n'), /缺少 H1 标题/)
})

test('第一节必须是背景', () => {
  assert.match(violationsOf({ text: '# 甲\n\n## 现象\n\n## 决策\n' }).join('\n'), /第一节必须是 `## 背景`/)
})

test('缺少决策节要报出来', () => {
  assert.match(violationsOf({ text: '# 甲\n\n## 背景\n\n## 验证\n' }).join('\n'), /缺少 `## 决策` 节/)
})

test('同名的节不能出现两次', () => {
  assert.match(violationsOf({ text: '# 甲\n\n## 背景\n\n## 决策\n\n## 背景\n' }).join('\n'), /`## 背景` 出现了 2 次/)
})

test('围栏里的 # 是示例，不算结构', () => {
  const text = '# 甲\n\n## 背景\n\n```markdown\n# 不是标题\n## 也不是节\n```\n\n## 决策\n'
  assert.deepEqual(violationsOf({ text }), [])
})

test('仓库现有笔记全部合规', () => {
  const dir = new URL('../.agents/notes/', import.meta.url)
  const names = readdirSync(dir).filter(name => name.endsWith('.md')).sort()
  assert.ok(names.length > 0, '.agents/notes 下没有笔记')
  const bad = names.flatMap(name => checkNote(name, readFileSync(new URL(name, dir), 'utf8')).map(v => `${name}: ${v}`))
  assert.deepEqual(bad, [])
})
