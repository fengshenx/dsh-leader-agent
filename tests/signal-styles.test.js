import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SIGNAL_PULSE_ANIMATION, signalStyleText } from '../src/client/signal-styles.js'

test('signalStyleText 产出 common 三档与唯一 keyframes', () => {
  const css = signalStyleText('demo-signal')

  // 基础点：尺寸与默认色相
  assert.ok(css.includes('.demo-signal {'), '基础选择器带前缀')
  for (const needle of [
    'width: 8px',
    'height: 8px',
    'border-radius: 50%',
    'corner-shape: round',
    '--demo-signal-tone: var(--dsw-alias-label-tertiary)',
    'opacity: 0.4',
  ]) assert.ok(css.includes(needle), `基础点缺少 ${needle}`)

  // running / unread / idle：色相、透明度与呼吸
  assert.ok(css.includes('.demo-signal-running {'), '有 running 档')
  assert.ok(css.includes('--demo-signal-tone: var(--dsw-alias-state-warn-primary)'), 'running 用 warn-primary')
  assert.ok(css.includes(`animation: ${SIGNAL_PULSE_ANIMATION} 1.6s ease-in-out infinite`), 'running 挂 1.6s 呼吸')
  assert.ok(css.includes('.demo-signal-unread {'), '有 unread 档')
  assert.ok(css.includes('--demo-signal-tone: var(--dsw-static-blue-500)'), 'unread 用蓝色')
  assert.ok(css.includes('.demo-signal-idle {'), '有 idle 档')
  assert.ok(css.includes('opacity: 0.55'), 'idle 弱化到 .55')

  // 呼吸只有一条 keyframes，名字由常量决定
  assert.equal(css.match(/@keyframes/g)?.length, 1, '只允许一条 keyframes')
  assert.ok(css.includes(`@keyframes ${SIGNAL_PULSE_ANIMATION} {`), 'keyframes 用共享名')
  assert.ok(css.includes('0%, 100% { opacity: 1; }'), 'keyframes 起点满不透明')
  assert.ok(css.includes('50% { opacity: 0.35; }'), 'keyframes 半程降到 .35')

  // reduced-motion 只关动画，不关状态色
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), '有 reduced-motion 规则')
  assert.ok(css.includes('.demo-signal-running { animation: none; }'), 'reduced-motion 关掉 running 的呼吸')
  assert.ok(css.includes('--demo-signal-tone: var(--dsw-alias-state-warn-primary)'), 'reduced-motion 不换成色')

  // 看板独有档位不进 common，否则两边的公共部分会再次分叉
  for (const own of ['-waiting', '-attention', '-unknown', '-none', '-hollow']) {
    assert.ok(!css.includes(own), `看板独有档位 ${own} 不应进 common`)
  }
  assert.ok(!css.includes('dsh-leader-agent-board') && !css.includes('dsh-leader-agent-tab'), '选择器前缀完全由调用方决定')
})

test('signalStyleText 对不同前缀生成结构相同、类名不同的样式', () => {
  const board = signalStyleText('board-signal')
  const tab = signalStyleText('tab-signal')
  assert.notEqual(board, tab)
  assert.equal(board.split('board-signal').length, tab.split('tab-signal').length, '两处替换前缀后结构一致')
  assert.equal(board.split('board-signal').join('X'), tab.split('tab-signal').join('X'), '除前缀外逐字一致')
})
