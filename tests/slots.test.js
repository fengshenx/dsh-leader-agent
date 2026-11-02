import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_SLOT_NAMES,
  SLOT_TEMPLATE_FILE,
  isValidSlotName,
  loadSlotTemplates,
  parseSlotTemplates,
} from '../src/host/slots/slot-templates.js'
import { renderRoleContext } from '../src/host/slots/role-context.js'

/**
 * 建一个带 `SLOTS.md` 的临时项目目录。
 *
 * @param {string | undefined} content - 文件内容；undefined 表示不写文件
 * @returns {Promise<{ directory: string, cleanup: () => Promise<void> }>} 目录与清理函数
 */
async function createProject(content) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-slots-'))
  if (content !== undefined) {
    await writeFile(join(directory, SLOT_TEMPLATE_FILE), content, 'utf8')
  }
  return {
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

test('解析按 ## 分节，正文归属所在槽位', () => {
  const slots = parseSlotTemplates([
    '## dev',
    '你是实现者。',
    '先写测试。',
    '',
    '## review',
    '你是评审者。',
  ].join('\n'))
  assert.equal(slots.size, 2)
  assert.equal(slots.get('dev'), '你是实现者。\n先写测试。')
  assert.equal(slots.get('review'), '你是评审者。')
})

test('同名槽位先见为准，后一节整节忽略', () => {
  const slots = parseSlotTemplates([
    '## dev',
    '第一个定义',
    '## dev',
    '第二个定义',
  ].join('\n'))
  assert.equal(slots.size, 1)
  assert.equal(slots.get('dev'), '第一个定义')
})

test('槽位名是 ASCII 机器标识，中文标题整节忽略', () => {
  const slots = parseSlotTemplates([
    '## dev',
    '你是开发者。',
    '## 开发',
    '中文标题的正文。',
    '## review',
    '你是审查者。',
  ].join('\n'))
  assert.equal(slots.size, 2)
  assert.equal(slots.get('dev'), '你是开发者。')
  assert.equal(slots.get('review'), '你是审查者。')
})

test('槽位名只接受小写 ASCII 字母数字下划线连字符，拒绝空白、标点与超长', () => {
  for (const name of ['review', 'dev_1', 'dev-1']) {
    assert.equal(isValidSlotName(name), true, name)
  }
  for (const name of ['', 'Dev', '开发', 'Bad Name', ' dev', 'dev ', 'dev/review', 'a'.repeat(33)]) {
    assert.equal(isValidSlotName(name), false, JSON.stringify(name))
  }
  assert.equal(isValidSlotName(undefined), false)
  assert.equal(isValidSlotName(42), false)
})

test('非法槽位名整节忽略，正文不归到上一节', () => {
  const slots = parseSlotTemplates([
    '## dev',
    '合法正文',
    '## Bad Name',
    '非法节的正文',
    '## review',
    '另一个合法正文',
  ].join('\n'))
  assert.equal(slots.size, 2)
  assert.equal(slots.get('dev'), '合法正文')
  assert.equal(slots.get('review'), '另一个合法正文')
})

test('空正文的槽位是合法条目，值为空串', () => {
  const slots = parseSlotTemplates('## dev\n\n## review\n正文\n')
  assert.equal(slots.size, 2)
  assert.equal(slots.get('dev'), '')
  assert.equal(slots.get('review'), '正文')
})

test('文件缺失时回落默认槽位名，正文为空', async () => {
  const project = await createProject(undefined)
  try {
    const slots = loadSlotTemplates(project.directory)
    assert.deepEqual([...slots.keys()], [...DEFAULT_SLOT_NAMES])
    assert.equal(slots.get('dev'), '')
  } finally {
    await project.cleanup()
  }
})

test('零合法条目时回落默认槽位名', async () => {
  const project = await createProject('## Bad Name\n正文\n')
  try {
    const slots = loadSlotTemplates(project.directory)
    assert.deepEqual([...slots.keys()], [...DEFAULT_SLOT_NAMES])
  } finally {
    await project.cleanup()
  }
})

test('有合法条目时读出正文', async () => {
  const project = await createProject('## dev\n你是实现者。\n')
  try {
    const slots = loadSlotTemplates(project.directory)
    assert.equal(slots.get('dev'), '你是实现者。')
  } finally {
    await project.cleanup()
  }
})

test('未绑定的会话渲染为空串', () => {
  const text = renderRoleContext({
    sessionId: 'session-a',
    slotIndex: new Map(),
    resolveDirectory: () => '/tmp/project',
  })
  assert.equal(text, '')
})

test('绑定了槽位但槽位无正文时渲染为空串', async () => {
  const project = await createProject('## dev\n')
  try {
    const text = renderRoleContext({
      sessionId: 'session-a',
      slotIndex: new Map([['session-a', 'dev']]),
      resolveDirectory: () => project.directory,
    })
    assert.equal(text, '')
  } finally {
    await project.cleanup()
  }
})

test('绑定且有正文时渲染出角色正文', async () => {
  const project = await createProject('## dev\n你是实现者。\n')
  try {
    const text = renderRoleContext({
      sessionId: 'session-a',
      slotIndex: new Map([['session-a', 'dev']]),
      resolveDirectory: () => project.directory,
    })
    assert.match(text, /你是实现者。/)
    assert.match(text, /不授予你任何工具权限/)
  } finally {
    await project.cleanup()
  }
})

test('会话没有工作目录时渲染为空串', () => {
  const text = renderRoleContext({
    sessionId: 'session-a',
    slotIndex: new Map([['session-a', 'dev']]),
    resolveDirectory: () => undefined,
  })
  assert.equal(text, '')
})
