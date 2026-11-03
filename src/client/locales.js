/**
 * 本插件界面文案的字典。
 *
 * 槽位名是机器标识：`SLOTS.md` 的分节名、卡片 `slots` 的 JSON 键、槽位注入的
 * 反查键都用它，形态固定为小写 ASCII（见 `src/host/slots/slot-templates.js`）。
 * 界面上的名字不跟标识走——这里按当前界面语言翻译内置槽位名，卡面 chip 与
 * 提示文案都用翻译后的名字。
 *
 * 槽位名之外的一次性界面文案（引导卡）也挂在同一个命名空间：宿主的
 * `locale/*.json` 只贡献插件显示名（`package-meta.ts` 只读 `title` /
 * `description`），界面字符串走 `ctx.locale.register`。
 *
 * 槽位名部分只放内置槽位的默认显示名。项目在 `SLOTS.md` 每节用 `label:` 声明
 * 自己的名字，优先级高于这份字典（`slotDisplayName`）；两者都没有时显示槽位名
 * 本身——不会因为缺翻译就看不见。
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
  'guide.title': '这个目录有一个 Leader 了',
  'guide.steps': '你可以让它建任务卡、给 Agent 派活，在右栏看板跟进',
  'guide.action.intro': '让它介绍一下自己',
  'guide.action.dismiss': '知道了',
  'guide.intro.prompt': '介绍一下你自己：你能帮我做什么，我该怎么用你？',
})

/** 英文字典，键与中文字典一致。 */
export const en = Object.freeze({
  'slot.discuss': 'Discuss',
  'slot.dev': 'Dev',
  'slot.review': 'Review',
  'guide.title': 'This directory has a Leader',
  'guide.steps': 'Open task cards, hand work to Agents, track progress in the board',
  'guide.action.intro': 'Ask it to introduce itself',
  'guide.action.dismiss': 'Got it',
  'guide.intro.prompt': 'Introduce yourself: what can you do for me, and how should I use you?',
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

/**
 * 卡面最终使用的槽位显示名。
 *
 * 优先级：项目 `SLOTS.md` 声明的 `label:` → 内置槽位的 locale 翻译 → 槽位名
 * 本身。项目自己决定怎么称呼角色时以项目为准；没声明时内置角色按界面语言显示，
 * 自定义槽位（新加的、字典里没有的）显示原名——不会因为缺翻译就看不见。
 *
 * @param {string} name - 槽位名（机器标识）
 * @param {Record<string, string> | undefined} labels - 项目下发的槽位显示名字典
 * @param {((key: string) => string) | undefined} t - 当前语言的翻译函数
 * @returns {string} 显示名
 */
export function slotDisplayName(name, labels, t) {
  const configured = labels?.[name]
  if (typeof configured === 'string' && configured !== '') return configured
  return slotLabel(name, t)
}
