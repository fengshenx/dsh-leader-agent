/**
 * 消息气泡的时间文本。
 *
 * 两个气泡（leader 任务、worker 回报）共用同一口径：与宿主的
 * `formatMessageClock` 对齐——今天只显示时分；同年往日显示日期；跨年再加年份。
 * 日期模板由 locale 字典给（中文「M月D日」、英文 `M/D`），时分是数字格式，
 * 两种语言一致。
 *
 * @module dsh-leader-agent/client/bubble-clock
 */

/**
 * 把时间戳格式成消息时钟。
 *
 * @param {number} time - 毫秒时间戳
 * @param {(key: string, params?: Record<string, unknown>) => string} t - 当前语言的翻译函数
 * @returns {string} 时钟文本
 */
export function formatBubbleClock(time, t) {
  const date = new Date(time)
  const now = new Date()
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()) {
    return clock
  }
  const parts = { month: date.getMonth() + 1, day: date.getDate() }
  const day = t('bubble.clock.day', parts)
  const md = date.getFullYear() === now.getFullYear()
    ? day
    : t('bubble.clock.dayYear', { ...parts, year: date.getFullYear() })
  return `${md} ${clock}`
}
