/**
 * 信号灯公共样式。
 *
 * 标签栏与看板卡面是同一个视觉契约：8px 实心点、状态色走宿主 token、运行中
 * 1.6s 透明度呼吸。两边各写一份 CSS 会静默漂移（只改了看板的呼吸周期，标签栏
 * 那条不动），所以 common 三档、呼吸动画与 reduced-motion 只在这里生成；
 * 看板独有的 waiting / attention / unknown / none / hollow 仍在看板样式表里。
 *
 * @module dsh-leader-agent/client/signal-styles
 */

/** 呼吸动画名。两条样式表引用同一个名字，不能各起一个。 */
export const SIGNAL_PULSE_ANIMATION = 'dsh-leader-agent-signal-pulse'

/**
 * 生成信号灯的公共样式：基础点 + running / unread / idle 三档 + 一条 keyframes
 * + reduced-motion 关闭 running 的呼吸。
 *
 * @param {string} prefix - 选择器前缀（同时派生 `--<prefix>-tone` 变量）
 * @returns {string} CSS 文本
 */
export function signalStyleText(prefix) {
  return `
.${prefix} {
  display: inline-block;
  box-sizing: border-box;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  corner-shape: round;
  --${prefix}-tone: var(--dsw-alias-label-tertiary);
  background: var(--${prefix}-tone);
  opacity: 0.4;
}
.${prefix}-running {
  --${prefix}-tone: var(--dsw-alias-state-warn-primary);
  opacity: 1;
  animation: ${SIGNAL_PULSE_ANIMATION} 1.6s ease-in-out infinite;
}
.${prefix}-unread {
  --${prefix}-tone: var(--dsw-static-blue-500);
  opacity: 1;
}
.${prefix}-idle {
  --${prefix}-tone: var(--dsw-alias-label-tertiary);
  opacity: 0.55;
}
@keyframes ${SIGNAL_PULSE_ANIMATION} {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .${prefix}-running { animation: none; }
}
`
}
