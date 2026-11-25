/**
 * 插件设置契约：宿主存储、远端通道与设置页共用同一份默认值与范围。
 *
 * 自动续行上限与看板显示模式都是**宿主侧**配置：前者决定 leader 无人值守时最多
 * 被自动唤醒多少次，后者决定看板渲染成列表还是线路图。两者都必须让宿主读写，
 * 不再存在浏览器 localStorage；默认值与校验因此放在 shared，宿主存储、远端通道
 * 与浏览器表单都从这里取。
 *
 * 上限不是「无限制」的替代品：撞上限后回报仍留在落盘队列里，人工开口即可放行。
 * 默认 200 的取舍见 `.agents/notes/implemented/feature/2026-11-25-auto-resume-limit-setting.md`。
 *
 * @module dsh-leader-agent/shared/settings
 */

/** 自动续行上限的默认值。 */
export const AUTO_RESUME_LIMIT_DEFAULT = 200

/** 允许配置的最小值：至少保留一次自动唤醒。 */
export const AUTO_RESUME_LIMIT_MIN = 1

/**
 * 允许配置的最大值。
 *
 * 设一个上界是为了挡住「填 1e9 当无限」这类输入：护栏本身仍要存在，只是把
 * 正常无人值守的窗口放长到 200 次；真要更长的无人值守，应该由人来重新开口。
 */
export const AUTO_RESUME_LIMIT_MAX = 10000

/**
 * 把用户输入解析成合法的自动续行上限。
 *
 * 接受数字与数字字符串（表单输入是字符串，远端通道传数字）。空串、小数、
 * 非有限数与越界值一律判非法，由调用方决定报错还是退回默认值。
 *
 * @param {unknown} raw - 原始输入
 * @returns {number | undefined} 合法值；非法时 undefined
 */
export function parseAutoResumeLimit(raw) {
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < AUTO_RESUME_LIMIT_MIN || value > AUTO_RESUME_LIMIT_MAX) return undefined
  return value
}

/** 看板工作模式：纯列表，零动效。 */
export const BOARD_MODE_WORK = 'work'

/** 看板炫酷模式：列表 + 主干与支线。 */
export const BOARD_MODE_CINEMA = 'cinema'

/** 默认看板模式：工作列表。炫酷模式是演示用途，需要显式开启。 */
export const BOARD_MODE_DEFAULT = BOARD_MODE_WORK

/** 全部合法看板模式，设置页按这个顺序渲染选项。 */
export const BOARD_MODES = Object.freeze([BOARD_MODE_WORK, BOARD_MODE_CINEMA])

/**
 * 把任意读到的值收成合法看板模式。
 *
 * 只有明确的 `cinema` 才算炫酷，其余（旧版遗留、手改坏、空值）一律回到工作
 * 模式：未知值不该把看板切成一个没人设计过的状态。
 *
 * @param {unknown} value - 待规范化的值
 * @returns {string} `work` 或 `cinema`
 */
export function normalizeBoardMode(value) {
  return value === BOARD_MODE_CINEMA ? BOARD_MODE_CINEMA : BOARD_MODE_WORK
}

/**
 * 把设置文件或远端入参解析成合法看板模式。
 *
 * 与 `normalizeBoardMode` 不同，这里对非法值返回 undefined，让保存路径拒绝写入；
 * 读路径才用 normalize 退回默认值。
 *
 * @param {unknown} raw - 原始输入
 * @returns {string | undefined} 合法模式；非法时 undefined
 */
export function parseBoardMode(raw) {
  return raw === BOARD_MODE_WORK || raw === BOARD_MODE_CINEMA ? raw : undefined
}
