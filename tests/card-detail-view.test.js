import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DETAIL_SPEC_EMPTY,
  canEditCardLinks,
  detailSections,
  statusLabel,
} from '../src/client/card-detail-view.js'

test('卡片没写说明时用统一的占位文案', () => {
  assert.equal(DETAIL_SPEC_EMPTY, '这张卡还没有写说明。')
  assert.equal(detailSections({}).spec, null)
})

test('状态徽章按卡片状态给中文名', () => {
  assert.equal(statusLabel('done'), '已完成')
  assert.equal(statusLabel('archived'), '已归档')
  assert.equal(statusLabel('active'), '进行中')
  assert.equal(statusLabel(undefined), '进行中')
})

test('详情分段：说明为空时不出说明段', () => {
  assert.equal(detailSections({ spec: '写点东西' }).spec, '写点东西')
  assert.equal(detailSections({ spec: '' }).spec, null)
  assert.equal(detailSections({}).spec, null)
  assert.equal(detailSections(undefined).spec, null)
})

test('详情分段只保留说明与链接', () => {
  const sections = detailSections({ spec: '验收标准', links: [], checkpoint: { summary: '旧字段' } })
  assert.deepEqual(Object.keys(sections).sort(), ['links', 'spec'])
})

test('详情分段：链接不是数组时当作空列表', () => {
  assert.deepEqual(detailSections({ links: '不是数组' }).links, [])
  assert.deepEqual(detailSections({ links: [{ label: '甲' }] }).links, [{ label: '甲' }])
})

test('归档卡不给链接编辑入口，已完成卡仍可改', () => {
  // 归档是卡片库的终态，给了入口也只会换回一条必然失败的报错。
  assert.equal(canEditCardLinks({ status: 'archived' }), false)
  assert.equal(canEditCardLinks({ status: 'done' }), true)
  assert.equal(canEditCardLinks({ status: 'active' }), true)
  // 状态缺失时按可编辑处理：写通道会给出真正的拒绝原因，界面不抢先猜。
  assert.equal(canEditCardLinks({}), true)
})
