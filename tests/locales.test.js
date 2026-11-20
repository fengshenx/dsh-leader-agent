/**
 * 界面字典的完整性：宿主 8 种语言的键集一致、占位符一致、没有空文案。
 *
 * 文案散落在各个组件里时，漏翻一个键只会让对应语言的界面突然冒出一句英文；
 * 这里把「字典本身对得上」变成门禁，组件只负责在正确的时机调用 `t`。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOCALE_UI, unknownLocaleCodes } from '../src/client/locales.js'
import { translator } from './helpers/locale.js'

const en = LOCALE_UI.en
const zh = LOCALE_UI.zh
/** 宿主当前注册的语言；插件随包提供同一组字典。 */
const HOST_CODES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']

/**
 * 取出模板里的 `{name}` 占位符。
 * @param {string} template - 文案模板
 * @returns {string[]} 占位符名（排序后）
 */
function placeholdersOf(template) {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

test('随包字典覆盖宿主注册的 8 种语言', () => {
  assert.deepEqual(Object.keys(LOCALE_UI).sort(), [...HOST_CODES].sort())
})

test('各语言字典键集一致', () => {
  for (const code of HOST_CODES) {
    assert.deepEqual(Object.keys(LOCALE_UI[code]).sort(), Object.keys(en).sort(), `${code} 的键集与 en 不一致`)
  }
})

test('每条文案都非空，且各语言的占位符一致', () => {
  for (const code of HOST_CODES) {
    const dict = LOCALE_UI[code]
    for (const key of Object.keys(en)) {
      assert.notEqual(dict[key].trim(), '', `${code}.${key} 为空`)
      assert.deepEqual(
        placeholdersOf(dict[key]),
        placeholdersOf(en[key]),
        `${code}.${key} 与 en.${key} 的占位符不一致`,
      )
    }
  }
})

test('重点文案的中英对照', () => {
  // tab 标题是最先暴露的一条：注册期 thunk 读的就是这两个键。
  assert.equal(zh['tab.board'], '看板')
  assert.equal(en['tab.board'], 'Board')
  assert.equal(zh['project.label'], '项目')
  assert.equal(en['project.label'], 'Projects')
})

test('只告警宿主目录里没有的 locale code', () => {
  const host = [{ id: 'zh' }, { id: 'en' }, { id: 'ja' }, 'fr']
  assert.deepEqual(unknownLocaleCodes({ en: {}, zh: {}, xx: {}, yy: {} }, host).sort(), ['xx', 'yy'])
  assert.deepEqual(unknownLocaleCodes({ en: {}, zh: {} }, host), [])
})

test('缺 key 时按宿主行为回退 en', () => {
  const partialZh = { ...zh }
  delete partialZh['tab.board']
  assert.equal(translator('zh', partialZh)('tab.board'), en['tab.board'])
})
