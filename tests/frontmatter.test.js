import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFrontmatter } from '../src/shared/frontmatter.js'

test('解析 name 与 description', () => {
  const { data, body } = parseFrontmatter('---\nname: demo\ndescription: 演示技能\n---\n正文内容\n')
  assert.equal(data.name, 'demo')
  assert.equal(data.description, '演示技能')
  assert.equal(body, '正文内容\n')
})

test('保留引号内的冒号与井号', () => {
  const { data } = parseFrontmatter('---\nname: demo\ndescription: "含: 冒号与 # 号"\n---\n')
  assert.equal(data.description, '含: 冒号与 # 号')
})

test('没有 frontmatter 时整体作为正文', () => {
  const { data, body } = parseFrontmatter('直接是正文\n')
  assert.deepEqual(data, {})
  assert.equal(body, '直接是正文\n')
})

test('未闭合的 frontmatter 不吞正文', () => {
  const text = '---\nname: demo\n没有结束标记\n'
  const { data } = parseFrontmatter(text)
  assert.equal(data.name, undefined)
})

test('忽略注释行与空行', () => {
  const { data } = parseFrontmatter('---\n# 注释\n\nname: demo\n---\n')
  assert.equal(data.name, 'demo')
})

test('解析一层嵌套 map，缩进子键归到上一个顶层键', () => {
  const { data } = parseFrontmatter([
    '---',
    'slots:',
    '  dev:',
    '    label: 开发',
    '  review:',
    '    label: 审核',
    'name: demo',
    '---',
  ].join('\n'))
  assert.deepEqual(data.slots, { dev: { label: '开发' }, review: { label: '审核' } })
  assert.equal(data.name, 'demo')
})

test('顶层键后没有子键时仍是空串，不变成对象', () => {
  const { data } = parseFrontmatter('---\nempty:\nname: demo\n---\n')
  assert.equal(data.empty, '')
  assert.equal(data.name, 'demo')
})

test('没有归属的缩进行忽略，不影响后续标量', () => {
  const { data } = parseFrontmatter('---\nname: demo\n  stray: x\nother: y\n---\n')
  assert.equal(data.name, 'demo')
  assert.equal(data.other, 'y')
  assert.deepEqual(Object.keys(data).sort(), ['name', 'other'])
})

test('无值键后跟更浅缩进时，键仍归它自己那一层', () => {
  const shallow = parseFrontmatter('---\nslots:\n  dev:\nname: demo\n---\n')
  assert.deepEqual(shallow.data, { slots: { dev: '' }, name: 'demo' })
  const nested = parseFrontmatter('---\nslots:\n  dev:\n    label:\nname: demo\n---\n')
  assert.deepEqual(nested.data, { slots: { dev: { label: '' } }, name: 'demo' })
})

test('重复的 slots 块合并，前一段的显示名不丢', () => {
  const { data, warnings } = parseFrontmatter([
    '---',
    'slots:',
    '  dev:',
    '    label: 开发',
    'slots:',
    '  review:',
    '    label: 审核',
    '---',
  ].join('\n'))
  assert.deepEqual(data.slots, { dev: { label: '开发' }, review: { label: '审核' } })
  assert.deepEqual(warnings, [])
})

test('同一路径两次给不同值时记录冲突，后者覆盖', () => {
  const { data, warnings } = parseFrontmatter([
    '---',
    'slots:',
    '  dev:',
    '    label: 开发',
    'slots:',
    '  dev:',
    '    label: 实现',
    '---',
  ].join('\n'))
  assert.equal(data.slots.dev.label, '实现')
  assert.deepEqual(warnings, ['重复键 slots.dev.label：先「开发」后「实现」，后者覆盖'])
})

test('剥离行内注释，引号内的井号保留，无空格前缀不剥', () => {
  const { data } = parseFrontmatter([
    '---',
    'label: 开发 # 显示名',
    'empty: # 只有注释',
    'described: "含 # 号的说明"',
    "single: 'a # b'",
    'attached: a#b',
    '---',
  ].join('\n'))
  assert.equal(data.label, '开发')
  assert.equal(data.empty, '')
  assert.equal(data.described, '含 # 号的说明')
  assert.equal(data.single, 'a # b')
  assert.equal(data.attached, 'a#b')
})

test('一致的 tab 缩进按一层处理', () => {
  const { data } = parseFrontmatter('---\nslots:\n\tdev:\n\t\tlabel: 开发\n---\n')
  assert.deepEqual(data.slots, { dev: { label: '开发' } })
})
