/**
 * 界面字典的完整性：中英键集一致、占位符一致、没有空文案。
 *
 * 文案散落在各个组件里时，漏翻一个键只会让英文界面突然冒出一句中文；这里把
 * 「字典本身对得上」变成门禁，组件只负责在正确的时机调用 `t`。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOCALE_UI } from '../src/client/locales.js'

const en = LOCALE_UI.en
const zh = LOCALE_UI.zh

/**
 * 取出模板里的 `{name}` 占位符。
 * @param {string} template - 文案模板
 * @returns {string[]} 占位符名（排序后）
 */
function placeholdersOf(template) {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

test('中英字典键集一致', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})

test('每条文案都非空，且两种语言的占位符一致', () => {
  for (const key of Object.keys(zh)) {
    assert.notEqual(zh[key].trim(), '', `zh.${key} 为空`)
    assert.notEqual(en[key].trim(), '', `en.${key} 为空`)
    assert.deepEqual(
      placeholdersOf(en[key]),
      placeholdersOf(zh[key]),
      `zh.${key} 与 en.${key} 的占位符不一致`,
    )
  }
})

test('重点文案的中英对照', () => {
  // tab 标题是最先暴露的一条：注册期 thunk 读的就是这两个键。
  assert.equal(zh['tab.board'], '看板')
  assert.equal(en['tab.board'], 'Board')
  assert.equal(zh['project.label'], '项目')
  assert.equal(en['project.label'], 'Projects')
})
