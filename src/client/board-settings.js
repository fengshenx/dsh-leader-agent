/**
 * 看板的设置页：注册到宿主的 `settings.section`，提供「炫酷 / 工作」两种模式。
 *
 * 宿主的设置导航是把槽位里的注册项直接列出来，没有官方白名单（见
 * `dsh-client-ui-settings-general` 的 `useSections`）；官方「模型」页也是普通注册。
 * 因此这里不需要宿主改动，也不需要 companion package。
 *
 * `ctx.slots.inject` 在槽位不存在时不会执行回调：旧宿主上没有这一节，设置页
 * 自然不出现，不会让插件在启动路径上抛错；看板按默认模式走。
 *
 * @module dsh-leader-agent/client/board-settings
 */

import { createElement, useEffect, useState } from 'react'
import {
  BOARD_MODE_CINEMA,
  BOARD_MODE_WORK,
  BOARD_MODES,
  readBoardMode,
  subscribeBoardMode,
  setBoardMode,
} from './board-mode.js'
import { readLocalStorage } from './guide-card-logic.js'
import { ensureBoardStyles } from './board-styles.js'

/** 注册键：与插件 id 同值，宿主按它排序与定位。 */
const SECTION_ID = 'dsh-leader-agent'

/** 设置导航里的排序：排在官方模型/搜索等页面之后。 */
const SECTION_ORDER = 90

/**
 * 模式到字典键。
 *
 * 写成静态表而不是拼 `board.mode.${value}.title`：locale 门禁按字面量扫描
 * 「哪些键被引用」，拼出来的键会被判成没人用。
 */
const MODE_KEYS = Object.freeze({
  [BOARD_MODE_CINEMA]: { title: 'board.mode.cinema.title', desc: 'board.mode.cinema.desc' },
  [BOARD_MODE_WORK]: { title: 'board.mode.work.title', desc: 'board.mode.work.desc' },
})

/**
 * 模式选项的小预览图。
 *
 * 只是示意：用两个 SVG 画出「主干 + 节点」与「三行列表」，让用户在点之前就能
 * 分辨两个模式。图形颜色走 currentColor，跟随宿主主题。
 *
 * @param {boolean} cinema - 是否画线路图
 * @returns {object} React 元素
 */
function ModePreview({ cinema }) {
  if (cinema) {
    return createElement(
      'svg',
      { width: 44, height: 30, viewBox: '0 0 44 30', fill: 'none', 'aria-hidden': 'true' },
      createElement('path', { d: 'M10 4V26', stroke: 'currentColor', strokeOpacity: 0.45, strokeWidth: 1.5 }),
      createElement('path', { d: 'M10 9H20M10 18H20M10 26H20', stroke: 'currentColor', strokeOpacity: 0.45, strokeWidth: 1.5 }),
      createElement('circle', { cx: 10, cy: 9, r: 2, fill: 'currentColor' }),
      createElement('circle', { cx: 10, cy: 18, r: 2, fill: 'currentColor' }),
      createElement('circle', { cx: 10, cy: 26, r: 2, fill: 'currentColor' }),
      createElement('circle', { cx: 36, cy: 9, r: 2.6, fill: 'var(--dsw-static-amber-400)' }),
    )
  }
  return createElement(
    'svg',
    { width: 44, height: 30, viewBox: '0 0 44 30', fill: 'none', 'aria-hidden': 'true' },
    createElement('rect', { x: 4, y: 4, width: 36, height: 6, rx: 2, fill: 'currentColor', fillOpacity: 0.22 }),
    createElement('rect', { x: 4, y: 12, width: 36, height: 6, rx: 2, fill: 'currentColor', fillOpacity: 0.22 }),
    createElement('rect', { x: 4, y: 20, width: 36, height: 6, rx: 2, fill: 'currentColor', fillOpacity: 0.22 }),
  )
}

/**
 * 一个模式选项。
 *
 * @param {object} props - 组件属性
 * @param {string} props.value - 该选项的模式值
 * @param {string} props.mode - 当前生效的模式
 * @param {(value: string) => void} props.onChoose - 选择回调
 * @param {(key: string) => string} props.t - 翻译函数
 * @returns {object} React 元素
 */
function ModeOption({ value, mode, onChoose, t }) {
  const selected = value === mode
  return createElement(
    'button',
    {
      type: 'button',
      role: 'radio',
      'aria-checked': selected,
      className: selected
        ? 'dsh-leader-agent-settings-option dsh-leader-agent-settings-option-selected'
        : 'dsh-leader-agent-settings-option',
      onClick: () => { onChoose(value) },
    },
    createElement(
      'span',
      { className: 'dsh-leader-agent-settings-preview' },
      createElement(ModePreview, { cinema: value === BOARD_MODE_CINEMA }),
    ),
    createElement(
      'span',
      { className: 'dsh-leader-agent-settings-copy' },
      createElement('b', null, t(MODE_KEYS[value].title)),
      createElement('span', null, t(MODE_KEYS[value].desc)),
    ),
    createElement('span', { className: 'dsh-leader-agent-settings-radio', 'aria-hidden': 'true' }),
  )
}

/**
 * 设置页主体。
 *
 * @param {object} props - 组件属性
 * @param {(key: string) => string} props.t - 翻译函数
 * @returns {object} React 元素
 */
function BoardSettingsSection({ t }) {
  const storage = readLocalStorage(globalThis)
  const [mode, setMode] = useState(() => readBoardMode(storage))
  // 宿主默认模式是异步补上的：设置页先打开时也要跟着换到判定后的模式
  useEffect(() => subscribeBoardMode(setMode), [])

  return createElement(
    'section',
    { className: 'dsh-leader-agent-settings' },
    createElement('h3', { className: 'dsh-leader-agent-settings-title' }, t('board.settings.title')),
    createElement('p', { className: 'dsh-leader-agent-settings-desc' }, t('board.settings.desc')),
    createElement(
      'div',
      {
        className: 'dsh-leader-agent-settings-options',
        role: 'radiogroup',
        'aria-label': t('board.settings.title'),
      },
      BOARD_MODES.map((value) => createElement(ModeOption, {
        key: value,
        value,
        mode,
        onChoose: (next) => setMode(setBoardMode(storage, next)),
        t,
      })),
    ),
    createElement('p', { className: 'dsh-leader-agent-settings-scope' }, t('board.settings.scope')),
  )
}

/**
 * 注册设置页。
 *
 * 样式表在这里一并注入：设置页可能先于看板被打开，等看板挂载再注入会闪一下
 * 无样式的页面。
 *
 * @param {object} ctx - 客户端上下文
 * @param {(key: string) => string} t - 翻译函数
 * @returns {void}
 */
export function mountBoardSettings(ctx, t) {
  ensureBoardStyles()
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: SECTION_ORDER,
    label: () => t('board.settings.nav'),
    inject: () => ({ t }),
  }, BoardSettingsSection)), 'dsh-leader-agent 设置页')
}
