/**
 * 消息气泡的时间文本。
 *
 * 两个气泡（leader 任务、worker 回报）共用同一口径：与宿主的
 * `formatMessageClock` 对齐（zh-CN 模板）——今天只显示时分；同年往日显示
 * 「M月D日 时分」；跨年再加年份。宿主按 i18n 模板渲染（英文环境下是 `M/D`），
 * 本仓不做多语言，固定用中文形态。
 *
 * @module dsh-leader-agent/client/bubble-clock
 */

/**
 * 把时间戳格式成消息时钟。
 *
 * @param {number} time - 毫秒时间戳
 * @returns {string} 时钟文本
 */
export function formatBubbleClock(time) {
  const date = new Date(time)
  const now = new Date()
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()) {
    return clock
  }
  const day = `${date.getMonth() + 1}月${date.getDate()}日`
  const md = date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()}年${day}`
  return `${md} ${clock}`
}
