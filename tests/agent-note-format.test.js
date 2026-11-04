import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditNotes, auditReport } from '../scripts/agent-note-audit.mjs'
import { checkLinks, checkNote } from '../scripts/agent-note-format.mjs'

const PATH = 'implemented/feature/2026-11-02-sample-note.md'

const IMPLEMENTED_TEXT =
  '# 示例标题\n\n## 背景\n\n为什么要有这篇。\n\n## 决策\n\n做了什么。\n\n## 边界\n\n## 验证\n\n- 用例\n'

/** 一份合规模板；用例只改要测的那一处。 */
function violationsOf({ path = PATH, text = IMPLEMENTED_TEXT } = {}) {
  return checkNote(path, text)
}

/** 造一份临时语料跑整条门禁，用于证明脚本确实调了判定。 */
function withCorpus(corpus, run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-leader-agent-notes-'))
  try {
    for (const [relPath, text] of Object.entries(corpus)) {
      const file = join(dir, relPath)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
    }
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

test('波浪线与缩进围栏里的 # 也是示例', () => {
  const tilde = '# 甲\n\n## 背景\n\n~~~markdown\n# 不是标题\n## 也不是节\n~~~\n\n## 决策\n'
  assert.deepEqual(violationsOf({ text: tilde }), [])
  const indented = '# 甲\n\n## 背景\n\n- 示例：\n\n  ~~~markdown\n  ## 决策\n  ~~~\n\n## 决策\n'
  assert.deepEqual(violationsOf({ text: indented }), [])
})

test('只有围栏里的决策节算缺节', () => {
  const text = '# 甲\n\n## 背景\n\n~~~markdown\n## 决策\n~~~\n'
  assert.match(violationsOf({ text }).join('\n'), /缺少 `## 决策` 节/)
})

test('围栏里的同名节不算重复', () => {
  const text = '# 甲\n\n## 背景\n\n## 决策\n\n~~~markdown\n## 决策\n~~~\n'
  assert.deepEqual(violationsOf({ text }), [])
})

test('四反引号围栏里的三反引号块仍是内容', () => {
  const backtick = '# 甲\n\n## 背景\n\n````markdown\n```\n## 决策\n```\n````\n'
  assert.match(violationsOf({ text: backtick }).join('\n'), /缺少 `## 决策` 节/)
  const tilde = '# 甲\n\n## 背景\n\n~~~~markdown\n~~~\n## 决策\n~~~\n~~~~\n'
  assert.match(violationsOf({ text: tilde }).join('\n'), /缺少 `## 决策` 节/)
})

test('不写状态行', () => {
  const text = '# 甲\n\n**状态**：implemented\n\n## 背景\n\n## 决策\n'
  assert.match(violationsOf({ text }).join('\n'), /路径即状态/)
  assert.deepEqual(violationsOf({ text: '# 甲\n\n## 背景\n\n正文里提到 `**状态**` 行不算。\n\n## 决策\n' }), [])
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

test('缩进与波浪线围栏里的链接示例不算', () => {
  const text = '# 甲\n\n## 背景\n\n- 示例：\n\n  ~~~markdown\n  [示例](./missing.md)\n  ~~~\n\n## 决策\n'
  assert.deepEqual(checkLinks(text, () => false), [])
})

test('语料里有断链就报——门禁确实调了链接判定', () => {
  withCorpus(
    {
      'implemented/feature/2026-11-02-a.md': '# 甲\n\n## 背景\n\n见[乙](2026-11-02-b.md)。\n\n## 决策\n',
      'implemented/feature/2026-11-02-b.md': '# 乙\n\n## 背景\n\n## 决策\n\n见[不存在](2026-11-02-missing.md)。\n',
    },
    (dir) => {
      const { violations } = auditNotes(dir)
      assert.equal(violations.length, 1, violations.join('\n'))
      assert.match(violations[0], /^implemented\/feature\/2026-11-02-b\.md — 链接目标不存在/)
    },
  )
})

test('语料里缺节就报——门禁确实调了结构判定', () => {
  withCorpus({ 'implemented/feature/2026-11-02-a.md': '# 甲\n\n## 背景\n\n没有决策节。\n' }, (dir) => {
    assert.match(auditNotes(dir).violations.join('\n'), /缺少 `## 决策` 节/)
  })
})

test('有违规时以 1 退出并把违规写到 stderr', () => {
  withCorpus({ 'implemented/feature/2026-11-02-a.md': '# 甲\n\n## 背景\n\n没有决策节。\n' }, (dir) => {
    const report = auditReport(auditNotes(dir))
    assert.equal(report.exitCode, 1)
    assert.equal(report.stream, 'error')
    assert.match(report.lines.join('\n'), /缺少 `## 决策` 节/)
  })
})

test('干净语料以 0 退出并报数', () => {
  withCorpus({ 'implemented/feature/2026-11-02-a.md': IMPLEMENTED_TEXT }, (dir) => {
    const report = auditReport(auditNotes(dir))
    assert.equal(report.exitCode, 0)
    assert.deepEqual(report.lines, ['verify-agent-note-format: 1 篇笔记格式合规（implemented 1）'])
  })
})

test('仓库现有笔记全部合规（含链接可达）', () => {
  const { notes, violations } = auditNotes(fileURLToPath(new URL('../.agents/notes/', import.meta.url)))
  assert.ok(notes.length > 0, '.agents/notes 下没有笔记')
  assert.deepEqual(violations, [])
})
