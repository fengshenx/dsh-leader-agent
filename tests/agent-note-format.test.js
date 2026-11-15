import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditNotes, auditReport } from '../scripts/agent-note-audit.mjs'
import { checkLinks, checkNote } from '../scripts/agent-note-format.mjs'

const IMPLEMENTED_PATH = 'implemented/feature/2026-11-02-sample-note.md'
const PROPOSED_PATH = 'proposed/feature/2026-11-02-sample-note.md'
const REJECTED_PATH = 'rejected/architecture/2026-11-02-sample-note.md'
const ARCHIVED_PATH = 'archived/feature/2026-11-02-sample-note.md'

const IMPLEMENTED_SECTIONS = [
  ['## Problem', '为什么要有这篇。'],
  ['## Decision', '做了什么。'],
  ['## Alternatives considered', '不做这个改动（原文未记录，本次补记）。'],
  ['## Consequences', '代价；收益。'],
  ['## Testing', '- 用例'],
]

const PROPOSED_SECTIONS = [
  ['## Problem', '为什么要有这篇。'],
  ['## Proposal', '打算怎么做。'],
  ['## Alternatives considered', '不做这个提案（原文未记录，本次补记）。'],
  ['## Acceptance criteria', '可观测的完成态。'],
  ['## Risks', '可能出问题的地方。'],
]

const REJECTED_SECTIONS = [
  ['## Problem', '为什么要有这篇。'],
  ['## Proposal', '打算怎么做。'],
  ['## Alternatives considered', '维持现状（原文未记录，本次补记）。'],
]

function bodyOf(sections) {
  return sections.map(([heading, content]) => `${heading}\n\n${content}`).join('\n\n')
}

/** 一份合规模板；用例只改要测的那一处。 */
function noteText({
  title = '# Agent Note: 示例标题',
  status = 'Status: implemented',
  sections = IMPLEMENTED_SECTIONS,
} = {}) {
  return `${title}\n\n${status}\n\n${bodyOf(sections)}\n`
}

function without(sections, heading) {
  return sections.filter(([candidate]) => candidate !== heading)
}

function violationsOf({ path = IMPLEMENTED_PATH, text = noteText() } = {}) {
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
  assert.deepEqual(
    violationsOf({ path: PROPOSED_PATH, text: noteText({ status: 'Status: proposed', sections: PROPOSED_SECTIONS }) }),
    [],
  )
  assert.deepEqual(
    violationsOf({ path: REJECTED_PATH, text: noteText({ status: 'Status: rejected — 与现有契约冲突', sections: REJECTED_SECTIONS }) }),
    [],
  )
  assert.deepEqual(violationsOf({ path: ARCHIVED_PATH, text: noteText() }), [])
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

test('第 1 行必须是 Agent Note 标题', () => {
  assert.match(violationsOf({ text: noteText({ title: '# 示例标题' }) }).join('\n'), /第 1 行必须是 `# Agent Note: <标题>`/)
  assert.match(violationsOf({ text: noteText({ title: '# Agent Note: ' }) }).join('\n'), /第 1 行必须是 `# Agent Note: <标题>`/)
})

test('头部第 2 与第 4 行必须是空行', () => {
  const missingAfterTitle = noteText().replace('# Agent Note: 示例标题\n\n', '# Agent Note: 示例标题\n')
  assert.match(violationsOf({ text: missingAfterTitle }).join('\n'), /第 2 行必须是空行/)
  const missingAfterStatus = noteText().replace('Status: implemented\n\n## Problem', 'Status: implemented\n## Problem')
  assert.match(violationsOf({ text: missingAfterStatus }).join('\n'), /第 4 行必须是空行/)
})

test('Status 形态与目录一致', () => {
  assert.match(
    violationsOf({ text: noteText({ status: 'Status: proposed' }) }).join('\n'),
    /第 3 行必须匹配 implemented 的 Status 形态/,
  )
  assert.match(
    violationsOf({ path: PROPOSED_PATH, text: noteText({ status: 'Status: implemented', sections: PROPOSED_SECTIONS }) }).join('\n'),
    /第 3 行必须匹配 proposed 的 Status 形态/,
  )
  assert.match(
    violationsOf({ path: REJECTED_PATH, text: noteText({ status: 'Status: rejected', sections: REJECTED_SECTIONS }) }).join('\n'),
    /第 3 行必须匹配 rejected 的 Status 形态/,
  )
  assert.match(
    violationsOf({ path: ARCHIVED_PATH, text: noteText({ status: 'Status: proposed' }) }).join('\n'),
    /第 3 行必须匹配 archived 的 Status 形态/,
  )
})

test('Status 行唯一且在第 3 行', () => {
  const duplicate = noteText({ sections: [...IMPLEMENTED_SECTIONS, ['## Related', 'Status: implemented']] })
  assert.match(violationsOf({ text: duplicate }).join('\n'), /`Status:` 行必须只出现在第 3 行/)
  const moved = '# Agent Note: 示例标题\n\n## Problem\n\nStatus: implemented\n\n' + bodyOf(IMPLEMENTED_SECTIONS)
  assert.match(violationsOf({ text: moved }).join('\n'), /`Status:` 行必须只出现在第 3 行/)
  const fenced = noteText({
    sections: [...IMPLEMENTED_SECTIONS, ['## 示例', '```markdown\nStatus: implemented\n```']],
  })
  assert.deepEqual(violationsOf({ text: fenced }), [])
})

test('H1 必须是第一行且只有一个', () => {
  assert.match(violationsOf({ text: noteText({ title: '## Problem' }) }).join('\n'), /缺少 H1 标题/)
  const notFirst = '前言\n\n# Agent Note: 示例标题\n\nStatus: implemented\n\n' + bodyOf(IMPLEMENTED_SECTIONS)
  assert.match(violationsOf({ text: notFirst }).join('\n'), /H1 必须是文件第一行/)
  assert.match(violationsOf({ text: noteText() + '\n# 乙\n' }).join('\n'), /H1 只能有一个/)
})

test('首节必须是 Problem', () => {
  const wrong = [['## 背景', '为什么。'], ...IMPLEMENTED_SECTIONS.slice(1)]
  assert.match(violationsOf({ text: noteText({ sections: wrong }) }).join('\n'), /第一节必须是 `## Problem`/)
  const none = '# Agent Note: 示例标题\n\nStatus: implemented\n\n正文。\n'
  assert.match(violationsOf({ text: none }).join('\n'), /正文没有分节/)
})

test('按 lifecycle 的必需节', () => {
  assert.match(violationsOf({ text: noteText({ sections: without(IMPLEMENTED_SECTIONS, '## Decision') }) }).join('\n'), /缺少 `## Decision`/)
  assert.match(violationsOf({ text: noteText({ sections: without(IMPLEMENTED_SECTIONS, '## Consequences') }) }).join('\n'), /缺少 `## Consequences`/)
  assert.match(
    violationsOf({ path: ARCHIVED_PATH, text: noteText({ sections: without(IMPLEMENTED_SECTIONS, '## Decision') }) }).join('\n'),
    /缺少 `## Decision`/,
  )
  assert.match(
    violationsOf({
      path: PROPOSED_PATH,
      text: noteText({ status: 'Status: proposed', sections: without(PROPOSED_SECTIONS, '## Acceptance criteria') }),
    }).join('\n'),
    /缺少 `## Acceptance criteria`/,
  )
  assert.match(
    violationsOf({
      path: PROPOSED_PATH,
      text: noteText({ status: 'Status: proposed', sections: without(PROPOSED_SECTIONS, '## Risks') }),
    }).join('\n'),
    /缺少 `## Risks`/,
  )
  assert.match(
    violationsOf({
      path: REJECTED_PATH,
      text: noteText({ status: 'Status: rejected — 原因', sections: without(REJECTED_SECTIONS, '## Proposal') }),
    }).join('\n'),
    /缺少 `## Proposal`/,
  )
  const chinese = IMPLEMENTED_SECTIONS.map(([heading, content]) => [heading === '## Decision' ? '## 决策' : heading, content])
  assert.match(violationsOf({ text: noteText({ sections: chinese }) }).join('\n'), /缺少 `## Decision`/)
})

test('implemented 禁止提案期节名', () => {
  for (const heading of ['## Proposal', '## Plan', '## Migration plan', '## Acceptance criteria']) {
    assert.match(
      violationsOf({ text: noteText({ sections: [...IMPLEMENTED_SECTIONS, [heading, '正文。']] }) }).join('\n'),
      /提案期节名/,
      `${heading} 应被禁`,
    )
  }
  assert.match(
    violationsOf({ text: noteText({ sections: [...IMPLEMENTED_SECTIONS, ['## plan', '正文。']] }) }).join('\n'),
    /提案期节名/,
  )
  assert.match(
    violationsOf({ text: noteText({ sections: [...IMPLEMENTED_SECTIONS, ['## ACCEPTANCE CRITERIA', '正文。']] }) }).join('\n'),
    /提案期节名/,
  )
  assert.deepEqual(
    violationsOf({
      path: PROPOSED_PATH,
      text: noteText({ status: 'Status: proposed', sections: [...PROPOSED_SECTIONS, ['## Plan', '计划。']] }),
    }),
    [],
  )
})

test('必须有 Alternatives considered', () => {
  const missing = noteText({ sections: without(IMPLEMENTED_SECTIONS, '## Alternatives considered') })
  assert.match(violationsOf({ text: missing }).join('\n'), /缺少 `## Alternatives considered`/)
  const grandfather = `${missing}\n<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->\n`
  assert.match(violationsOf({ text: grandfather }).join('\n'), /缺少 `## Alternatives considered`/)
})

test('禁止 legacy marker', () => {
  for (const marker of ['XXX: legacy ADR/RFC body format', 'XXX: legacy ADR/Agent Note body format']) {
    assert.match(
      violationsOf({ text: noteText({ sections: [...IMPLEMENTED_SECTIONS, ['## Related', marker]] }) }).join('\n'),
      /legacy marker/,
      `${marker} 应被禁`,
    )
  }
  const fenced = noteText({
    sections: [...IMPLEMENTED_SECTIONS, ['## 示例', '```markdown\nXXX: legacy ADR/RFC body format\n```']],
  })
  assert.deepEqual(violationsOf({ text: fenced }), [])
})

test('同名的节不能出现两次', () => {
  assert.match(
    violationsOf({ text: noteText({ sections: [...IMPLEMENTED_SECTIONS, ['## Decision', '重复。']] }) }).join('\n'),
    /`## Decision` 出现了 2 次/,
  )
})

test('围栏里的 # 是示例，不算结构', () => {
  const sections = [
    ['## Problem', '为什么。'],
    ['## 示例', '```markdown\n# 不是标题\n## 也不是节\n```'],
    ['## Decision', '做了什么。'],
    ['## Alternatives considered', '默认。'],
    ['## Consequences', '代价；收益。'],
  ]
  assert.deepEqual(violationsOf({ text: noteText({ sections }) }), [])
})

test('波浪线与缩进围栏里的 # 也是示例', () => {
  const tilde = [
    ['## Problem', '为什么。'],
    ['## 示例', '~~~markdown\n# 不是标题\n## 也不是节\n~~~'],
    ['## Decision', '做了什么。'],
    ['## Alternatives considered', '默认。'],
    ['## Consequences', '代价；收益。'],
  ]
  assert.deepEqual(violationsOf({ text: noteText({ sections: tilde }) }), [])
  const indented = [
    ['## Problem', '为什么。'],
    ['## 示例', '- 示例：\n\n  ~~~markdown\n  ## Decision\n  ~~~'],
    ['## Decision', '做了什么。'],
    ['## Alternatives considered', '默认。'],
    ['## Consequences', '代价；收益。'],
  ]
  assert.deepEqual(violationsOf({ text: noteText({ sections: indented }) }), [])
})

test('只有围栏里的决策节算缺节', () => {
  const sections = [
    ['## Problem', '为什么。'],
    ['## 示例', '~~~markdown\n## Decision\n~~~'],
    ['## Alternatives considered', '默认。'],
    ['## Consequences', '代价；收益。'],
  ]
  assert.match(violationsOf({ text: noteText({ sections }) }).join('\n'), /缺少 `## Decision` 节/)
})

test('围栏里的同名节不算重复', () => {
  const sections = [
    ['## Problem', '为什么。'],
    ['## Decision', '做了什么。'],
    ['## 示例', '~~~markdown\n## Decision\n~~~'],
    ['## Alternatives considered', '默认。'],
    ['## Consequences', '代价；收益。'],
  ]
  assert.deepEqual(violationsOf({ text: noteText({ sections }) }), [])
})

test('四反引号围栏里的三反引号块仍是内容', () => {
  const sections = [
    ['## Problem', '为什么。'],
    ['## 示例', '````markdown\n```\n## Decision\n```\n````'],
    ['## Alternatives considered', '默认。'],
    ['## Consequences', '代价；收益。'],
  ]
  assert.match(violationsOf({ text: noteText({ sections }) }).join('\n'), /缺少 `## Decision` 节/)
})

test('笔记间链接必须可达', () => {
  const text = '# Agent Note: 甲\n\nStatus: implemented\n\n## Problem\n\n见[另一篇](../architecture/2026-11-02-other.md)。\n\n## Decision\n\n## Alternatives considered\n\n## Consequences\n'
  assert.deepEqual(checkLinks(text, () => true), [])
  assert.match(checkLinks(text, () => false).join('\n'), /链接目标不存在：`\.\.\/architecture\/2026-11-02-other\.md`/)
})

test('外链、纯锚点与非 Markdown 目标不判', () => {
  const text = '# Agent Note: 甲\n\nStatus: implemented\n\n## Problem\n\n[外链](https://example.com/a.md) [锚点](#decision) [目录](../docs/architecture)\n\n## Decision\n\n## Alternatives considered\n\n## Consequences\n'
  assert.deepEqual(checkLinks(text, () => false), [])
})

test('围栏里的链接示例不算', () => {
  const text = '# Agent Note: 甲\n\nStatus: implemented\n\n## Problem\n\n```markdown\n[示例](./missing.md)\n```\n\n## Decision\n\n## Alternatives considered\n\n## Consequences\n'
  assert.deepEqual(checkLinks(text, () => false), [])
})

test('缩进与波浪线围栏里的链接示例不算', () => {
  const text = '# Agent Note: 甲\n\nStatus: implemented\n\n## Problem\n\n- 示例：\n\n  ~~~markdown\n  [示例](./missing.md)\n  ~~~\n\n## Decision\n\n## Alternatives considered\n\n## Consequences\n'
  assert.deepEqual(checkLinks(text, () => false), [])
})

test('语料里有断链就报——门禁确实调了链接判定', () => {
  withCorpus(
    {
      'implemented/feature/2026-11-02-a.md': noteText(),
      'implemented/feature/2026-11-02-b.md': noteText({
        sections: [
          ['## Problem', '见[不存在](2026-11-02-missing.md)。'],
          ...IMPLEMENTED_SECTIONS.slice(1),
        ],
      }),
    },
    (dir) => {
      const { violations } = auditNotes(dir)
      assert.equal(violations.length, 1, violations.join('\n'))
      assert.match(violations[0], /^implemented\/feature\/2026-11-02-b\.md — 链接目标不存在/)
    },
  )
})

test('语料里缺节就报——门禁确实调了结构判定', () => {
  withCorpus(
    { 'implemented/feature/2026-11-02-a.md': noteText({ sections: without(IMPLEMENTED_SECTIONS, '## Decision') }) },
    (dir) => {
      assert.match(auditNotes(dir).violations.join('\n'), /缺少 `## Decision` 节/)
    },
  )
})

test('有违规时以 1 退出并把违规写到 stderr', () => {
  withCorpus(
    { 'implemented/feature/2026-11-02-a.md': noteText({ sections: without(IMPLEMENTED_SECTIONS, '## Decision') }) },
    (dir) => {
      const report = auditReport(auditNotes(dir))
      assert.equal(report.exitCode, 1)
      assert.equal(report.stream, 'error')
      assert.match(report.lines.join('\n'), /缺少 `## Decision` 节/)
    },
  )
})

test('干净语料以 0 退出并报数', () => {
  withCorpus({ 'implemented/feature/2026-11-02-a.md': noteText() }, (dir) => {
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
