import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isJumpableLink, linkRowKey, planLinkRow } from '../src/client/link-row.js'

test('只有 http(s) 链接能跳转，空值、非字符串与非 http scheme 都不能', () => {
  assert.equal(isJumpableLink({ label: '甲', url: 'https://example.com' }), true)
  assert.equal(isJumpableLink({ label: '甲', url: 'http://example.com' }), true)
  assert.equal(isJumpableLink({ label: '甲', url: '' }), false)
  assert.equal(isJumpableLink({ label: '甲' }), false)
  assert.equal(isJumpableLink({ label: '甲', url: 42 }), false)
  assert.equal(isJumpableLink(undefined), false)
  // 卡片工具不校验 scheme，存量卡里可能有这类 URL；渲染成 href 就是注入面。
  assert.equal(isJumpableLink({ label: '甲', url: 'javascript:alert(1)' }), false)
  assert.equal(isJumpableLink({ label: '甲', url: 'docs/report.md' }), false)
})

test('chip 的 key 优先用 id，缺 id 时用标签加序号兜底', () => {
  assert.equal(linkRowKey({ id: 'x1', label: '甲' }, 0), 'x1')
  assert.equal(linkRowKey({ label: '甲' }, 2), '甲-2')
  assert.equal(linkRowKey({}, 0), '-0')
})

test('标签重复且没有 id 时，不同位置的链接拿到不同的 key', () => {
  const first = linkRowKey({ label: '文档' }, 0)
  const second = linkRowKey({ label: '文档' }, 1)
  assert.notEqual(first, second)
})

test('排布计划：可见 chip 按数量截断，收起的合成「+N」', () => {
  const links = [{ label: '一' }, { label: '二' }, { label: '三' }]
  const plan = planLinkRow(links, 2)
  assert.deepEqual(plan.visible.map((link) => link.label), ['一', '二'])
  assert.equal(plan.overflow, '+1')
  assert.equal(plan.measureOverflow, '+3')
})

test('排布计划：全部可见时没有溢出 chip', () => {
  const links = [{ label: '一' }, { label: '二' }]
  const plan = planLinkRow(links, 2)
  assert.equal(plan.overflow, null)
  assert.equal(plan.visible.length, 2)
})

test('排布计划：可见数越界时收敛到链接数', () => {
  const links = [{ label: '一' }, { label: '二' }]
  assert.equal(planLinkRow(links, 99).visible.length, 2)
  assert.equal(planLinkRow(links, -3).visible.length, 0)
  assert.equal(planLinkRow(links, Number.NaN).visible.length, 2)
})

test('排布计划：测量层的「+N」取上界，可见层取实际收起数', () => {
  const links = Array.from({ length: 12 }, (_, index) => ({ label: `第${index}个` }))
  const plan = planLinkRow(links, 9)
  assert.equal(plan.measureOverflow, '+12')
  assert.equal(plan.overflow, '+3')
})
