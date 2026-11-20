/**
 * 测试用的翻译函数：从插件的真实字典取值，插值与缺 key 回退规则照宿主 `LocaleRuntime`。
 *
 * 纯函数与组件里已经没有中文文案，测试要断言「中文界面显示什么」就得走真实
 * 字典；自己再抄一份期望文本会让字典改了、测试还绿着。
 *
 * @module dsh-leader-agent/tests/helpers/locale
 */

import { LOCALE_UI } from '../../src/client/locales.js'

/**
 * 造一个指定语言的翻译函数。
 *
 * @param {string} [locale] - 语言码，默认简体中文
 * @param {Record<string, string>} [dict] - 测试用字典；缺省取生成字典，便于造缺 key 场景
 * @returns {(key: string, params?: Record<string, unknown>) => string} 翻译函数
 */
export function translator(locale = 'zh', dict = LOCALE_UI[locale]) {
  if (dict === undefined) throw new Error(`测试没有 ${locale} 字典`)
  return (key, params) => {
    const template = dict[key] ?? LOCALE_UI.en[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (
      name in params ? String(params[name]) : match
    ))
  }
}
