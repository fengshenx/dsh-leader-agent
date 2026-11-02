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
