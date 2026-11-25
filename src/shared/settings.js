/**
 * 插件设置契约：宿主存储、远端通道与设置页共用同一份默认值与范围。
 *
 * 自动续行上限是**宿主侧**配置：它决定 leader 无人值守时最多被自动唤醒多少次
 * 来处理 worker 回报。与看板显示模式不同，它必须让机制侧读到，不能只存在浏览器
 * localStorage 里；因此默认值与校验放在 shared，宿主存储与浏览器表单都从这里取。
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
