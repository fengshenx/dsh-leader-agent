/**
 * 本插件的 locale 命名空间与槽位显示名。
 *
 * 界面文案的唯一事实来源是 `locale/<code>.json` 的 `ui`：`build/locales.mjs`
 * 把它们生成到 `locales.generated.js`，客户端注册时按文件枚举所有语言，不在
 * 代码里写死 `zh` / `en`。`meta` 只供宿主读插件显示名，不属于客户端字典。
 *
 * 槽位名是机器标识：`SLOTS.md` 的分节名、卡片 `slots` 的 JSON 键、槽位注入的
 * 反查键都用它，形态固定为小写 ASCII（见 `src/host/slots/slot-templates.js`）。
 * 界面上的名字不跟标识走——这里按当前界面语言翻译内置槽位名，卡面 chip 与
 * 提示文案都用翻译后的名字。
 *
 * 槽位名部分只放内置槽位的默认显示名。项目在 `SLOTS.md` 每节用 `label:` 声明
 * 自己的名字，优先级高于这份字典（`slotDisplayName`）；两者都没有时显示槽位名
 * 本身——不会因为缺翻译就看不见。
 *
 * @module dsh-leader-agent/client/locales
 */

import { LOCALE_UI } from './locales.generated.js'

export { LOCALE_UI }

/**
 * locale 文件里有、宿主语言目录里没有的 code。
 *
 * 生成物可能先于宿主支持列表出现（例如本地刚加了 `locale/xx.json`）；这种语言
 * 注册进宿主也不会被选中，启动时告警比静默丢失可发现。宿主列表是运行时的，
 * 这里只比较、不断言——写进构建门禁会在宿主加语言时漂移。
 *
 * @param {Record<string, unknown>} localeUi - 生成字典
 * @param {Array<{ id?: string } | string>} hostLocales - 宿主 `getSnapshot().locales`
 * @returns {string[]} 宿主目录里缺失的语言码
 */
export function unknownLocaleCodes(localeUi, hostLocales) {
  const known = new Set(hostLocales.map((locale) => (typeof locale === 'string' ? locale : locale?.id)).filter(Boolean))
  return Object.keys(localeUi).filter((code) => !known.has(code))
}

/** 本插件的 locale 命名空间。 */
export const SLOT_LOCALE_NAMESPACE = 'dsh-leader-agent'

/**
 * 槽位名到字典键。
 *
 * 内置槽位（`DEFAULT_SLOT_NAMES`）在这里必须有键；`discuss` 不在默认槽位里，
 * 保留翻译是为了项目自己加同名槽位时仍显示中文。新增内置槽位时两处一起改。
 */
export const SLOT_LABEL_KEYS = Object.freeze({
  discuss: 'slot.discuss',
  dev: 'slot.dev',
  review: 'slot.review',
})

/**
 * 槽位名的显示文本。
 *
 * `t` 缺失时回落原名：槽位芯片只是卡面装饰信息，宿主没注入翻译席位不该让整块
 * 看板崩掉。
 *
 * @param {string} name - 槽位名（机器标识）
 * @param {((key: string, params?: Record<string, unknown>) => string) | undefined} t - 当前语言的翻译函数
 * @returns {string} 显示名；没有内置翻译或翻译函数缺失时原样返回槽位名
 */
export function slotLabel(name, t) {
  const key = SLOT_LABEL_KEYS[name]
  if (key === undefined || typeof t !== 'function') return name
  return t(key)
}

/**
 * 卡面最终使用的槽位显示名。
 *
 * 优先级：项目 `SLOTS.md` 声明的 `label:` → 内置槽位的 locale 翻译 → 槽位名
 * 本身。项目自己决定怎么称呼角色时以项目为准；没声明时内置角色按界面语言显示，
 * 自定义槽位（新加的、字典里没有的）显示原名——不会因为缺翻译就看不见。
 *
 * @param {string} name - 槽位名（机器标识）
 * @param {Record<string, string> | undefined} labels - 项目下发的槽位显示名字典
 * @param {((key: string, params?: Record<string, unknown>) => string) | undefined} t - 当前语言的翻译函数
 * @returns {string} 显示名
 */
export function slotDisplayName(name, labels, t) {
  const configured = labels?.[name]
  if (typeof configured === 'string' && configured !== '') return configured
  return slotLabel(name, t)
}
