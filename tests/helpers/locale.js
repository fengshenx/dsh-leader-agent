/**
 * 测试用的翻译函数：从插件的真实字典取值，插值规则照宿主 `LocaleRuntime`。
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
 * @returns {(key: string, params?: Record<string, unknown>) => string} 翻译函数
 */
export function translator(locale = 'zh') {
  const dict = LOCALE_UI[locale]
  if (dict === undefined) throw new Error(`测试没有 ${locale} 字典`)
  return (key, params) => {
    const template = dict[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (
      name in params ? String(params[name]) : match
    ))
  }
}
