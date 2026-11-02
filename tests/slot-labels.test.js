import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SLOT_LABEL_KEYS,
  en,
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

test('中英文字典键集一致，且覆盖全部内置槽位键', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const key of Object.values(SLOT_LABEL_KEYS)) {
    assert.ok(key in zh, key)
    assert.ok(key in en, key)
  }
})
