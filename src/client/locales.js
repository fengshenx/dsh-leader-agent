/**
 * 槽位名的界面显示字典。
 *
 * 槽位名是机器标识：`SLOTS.md` 的分节名、卡片 `slots` 的 JSON 键、槽位注入的
 * 反查键都用它，形态固定为小写 ASCII（见 `src/host/slots/slot-templates.js`）。
 * 界面上的名字不跟标识走——这里按当前界面语言翻译内置槽位名，卡面 chip 与
 * 提示文案都用翻译后的名字。
 *
 * 字典只覆盖内置槽位。项目自定义槽位没有翻译时显示原名：显示名不是配置的
 * 一部分，缺翻译就应当看见真实的键，而不是猜一个名字。
 *
 * @module dsh-leader-kit/client/locales
 */

/** 本插件的 locale 命名空间。 */
export const SLOT_LOCALE_NAMESPACE = 'dsh-leader-kit'

/**
 * 内置槽位名到字典键。
 *
 * 与 `DEFAULT_SLOT_NAMES` 的三个角色对齐；新增内置槽位时两处一起改。
 */
export const SLOT_LABEL_KEYS = Object.freeze({
  discuss: 'slot.discuss',
  dev: 'slot.dev',
  review: 'slot.review',
})

/** 简体中文字典（键集的事实来源）。 */
export const zh = Object.freeze({
  'slot.discuss': '讨论',
  'slot.dev': '开发',
  'slot.review': '审核',
})

/** 英文字典，键与中文字典一致。 */
export const en = Object.freeze({
  'slot.discuss': 'Discuss',
  'slot.dev': 'Dev',
  'slot.review': 'Review',
})

/**
 * 槽位名的显示文本。
 *
 * `t` 缺失时回落原名：槽位芯片只是卡面装饰信息，宿主没注入翻译席位不该让整块
 * 看板崩掉。
 *
 * @param {string} name - 槽位名（机器标识）
 * @param {((key: string) => string) | undefined} t - 当前语言的翻译函数
 * @returns {string} 显示名；没有内置翻译或翻译函数缺失时原样返回槽位名
 */
export function slotLabel(name, t) {
  const key = SLOT_LABEL_KEYS[name]
  if (key === undefined || typeof t !== 'function') return name
  return t(key)
}
