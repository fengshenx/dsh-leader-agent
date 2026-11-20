import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canDeleteCard,
  canEditCardLinks,
  describeCardRemoval,
  detailSections,
  statusLabel,
} from '../src/client/card-detail-view.js'
import { LOCALE_UI } from '../src/client/locales.js'

const zh = LOCALE_UI.zh
import { translator } from './helpers/locale.js'

const t = translator('zh')

test('卡片没写说明时用统一的占位文案', () => {
  assert.equal(zh['card.detail.empty'], '这张卡还没有写说明。')
  assert.equal(detailSections({}).spec, null)
})

test('状态徽章按卡片状态给中文名', () => {
  assert.equal(statusLabel('done', t), '已完成')
  assert.equal(statusLabel('archived', t), '已归档')
  assert.equal(statusLabel('active', t), '进行中')
  assert.equal(statusLabel(undefined, t), '进行中')
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

test('详情删除：有 id 才能删，不按状态拦', () => {
  // 归档卡到不了详情（看板只渲染 active / done），判据不看状态，只认非空 id。
  assert.equal(canDeleteCard({ id: 'c1', status: 'archived' }), true)
  assert.equal(canDeleteCard({ id: 'c1' }), true)
  assert.equal(canDeleteCard({ id: '' }), false)
  assert.equal(canDeleteCard({ id: 1 }), false)
  assert.equal(canDeleteCard({}), false)
})

test('删除确认说清编号、标题、不可恢复与槽位解除', () => {
  assert.equal(
    describeCardRemoval({ number: 7, title: '补测试' }, t),
    '将删除卡片 #7「补测试」。删除后不可恢复，编号不会再分配，卡片上的槽位绑定会一并解除。',
  )
  assert.match(describeCardRemoval({}, t), /#\?/)
})
