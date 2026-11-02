import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SLOT_LABEL_KEYS,
  en,
  slotDisplayName,
  slotLabel,
  zh,
} from '../src/client/locales.js'

test('内置槽位按当前语言显示', () => {
  const zhT = (key) => zh[key]
  assert.equal(slotLabel('dev', zhT), '开发')
  assert.equal(slotLabel('review', zhT), '审核')
  assert.equal(slotLabel('discuss', zhT), '讨论')
  assert.equal(slotLabel('dev', (key) => en[key]), 'Dev')
})

test('自定义槽位没有翻译时显示原名，不查字典', () => {
  let calls = 0
  const t = () => {
    calls += 1
    return '不应调用'
  }
  assert.equal(slotLabel('audit', t), 'audit')
  assert.equal(calls, 0)
})

test('翻译函数缺失时回落原名', () => {
  assert.equal(slotLabel('dev', undefined), 'dev')
  assert.equal(slotLabel('dev', null), 'dev')
})

test('显示名优先级：项目 label → locale → 原名', () => {
  const t = (key) => zh[key]
  assert.equal(slotDisplayName('dev', { dev: '实现' }, t), '实现')
  assert.equal(slotDisplayName('dev', {}, t), '开发')
  assert.equal(slotDisplayName('audit', {}, t), 'audit')
  assert.equal(slotDisplayName('audit', { audit: '审计' }, t), '审计')
  // 项目声明空串按未声明处理，回到 locale
  assert.equal(slotDisplayName('dev', { dev: '' }, t), '开发')
  assert.equal(slotDisplayName('dev', undefined, undefined), 'dev')
})

test('中英文字典键集一致，且覆盖全部内置槽位键', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const key of Object.values(SLOT_LABEL_KEYS)) {
    assert.ok(key in zh, key)
    assert.ok(key in en, key)
  }
})
