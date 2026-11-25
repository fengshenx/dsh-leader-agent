/**
 * 插件设置页：注册到宿主的 `settings.section`。
 *
 * 页面按「显示偏好 / 运行护栏」分两块，不把两类配置混在同一组控件里：
 *
 * - **任务看板**：工作 / 炫酷两种呈现方式；
 * - **自动续行**：leader 无人值守时最多被自动唤醒多少次。
 *
 * 两块都落在宿主侧 `settings.json`，所有项目共用；分区是因为一个管显示、一个
 * 管机制护栏，不是两种存储域。范围说明分开写，避免用户把显示偏好读成项目配置。
 *
 * 宿主的设置导航是把槽位里的注册项直接列出来，没有官方白名单；`ctx.slots.inject`
 * 在槽位不存在时不会执行回调，旧宿主上没有这一节，设置页自然不出现。
 *
 * @module dsh-leader-agent/client/board-settings
 */

import { createElement, useEffect, useState } from 'react'
import {
  BOARD_MODE_CINEMA,
  BOARD_MODE_WORK,
  BOARD_MODES,
  getBoardMode,
  normalizeBoardMode,
  setBoardMode,
  subscribeBoardMode,
} from './board-mode.js'
import { ensureBoardStyles } from './board-styles.js'
import { callProjectRemote } from './project-remote.js'
import {
  AUTO_RESUME_LIMIT_DEFAULT,
  AUTO_RESUME_LIMIT_MAX,
  AUTO_RESUME_LIMIT_MIN,
  parseAutoResumeLimit,
} from '../shared/settings.js'

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
 * 把异常转成可放进提示的一句话。
 *
 * 远端错误自带 code / method 等技术细节，原样显示给用户；这里只做字符串化，
 * 不在这里翻译宿主文案。
 *
 * @param {unknown} error - 捕获到的异常
 * @returns {string} 提示正文
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 模式图标：工作模式三行列表，炫酷模式主干与支线。
 *
 * 尺寸取 18px，与宿主「外观」里的主题图标同一档；颜色走 currentColor，
 * 选中态由按钮的 background/border 表达，不在这里写第二套强调色。
 *
 * @param {boolean} cinema - 是否画线路图
 * @returns {object} React 元素
 */
function ModeIcon({ cinema }) {
  if (cinema) {
    return createElement(
      'svg',
      { width: 16, height: 16, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': 'true' },
      createElement('path', { d: 'M4 3V15', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      createElement('path', { d: 'M4 6H10M4 12H10', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      createElement('circle', { cx: 4, cy: 6, r: 1.5, fill: 'currentColor' }),
      createElement('circle', { cx: 4, cy: 12, r: 1.5, fill: 'currentColor' }),
      createElement('circle', { cx: 12, cy: 6, r: 1.5, fill: 'currentColor' }),
    )
  }
  return createElement(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': 'true' },
    createElement('rect', { x: 3, y: 3.5, width: 12, height: 3, rx: 1.5, fill: 'currentColor', fillOpacity: 0.25 }),
    createElement('rect', { x: 3, y: 7.5, width: 12, height: 3, rx: 1.5, fill: 'currentColor', fillOpacity: 0.25 }),
    createElement('rect', { x: 3, y: 11.5, width: 12, height: 3, rx: 1.5, fill: 'currentColor', fillOpacity: 0.25 }),
  )
}

/**
 * 一个模式选项：宿主 themeCube 的样式，图标在上、标题在下。
 *
 * @param {object} props - 组件属性
 * @param {string} props.value - 该选项的模式值
 * @param {string} props.mode - 当前生效的模式
 * @param {(value: string) => void} props.onChoose - 选择回调
 * @param {boolean} props.disabled - 读配置或保存中禁用
 * @param {(key: string) => string} props.t - 翻译函数
 * @returns {object} React 元素
 */
function ModeOption({ value, mode, onChoose, disabled, t }) {
  const selected = value === mode
  return createElement(
    'button',
    {
      type: 'button',
      role: 'radio',
      'aria-checked': selected,
      disabled,
      className: selected
        ? 'dsh-leader-agent-settings-option dsh-leader-agent-settings-option-selected'
        : 'dsh-leader-agent-settings-option',
      onClick: () => { onChoose(value) },
    },
    createElement(
      'span',
      { className: 'dsh-leader-agent-settings-option-icon' },
      createElement(ModeIcon, { cinema: value === BOARD_MODE_CINEMA }),
    ),
    createElement('span', { className: 'dsh-leader-agent-settings-option-label' }, t(MODE_KEYS[value].title)),
    createElement('span', { className: 'dsh-leader-agent-settings-option-desc' }, t(MODE_KEYS[value].desc)),
  )
}

/**
 * 「任务看板」分区：显示模式存在宿主设置，所有项目共用。
 *
 * 点击选项即保存，不做乐观更新：宿主写盘成功后才广播给看板并改选中态；失败时
 * 保留原选择并就地报错，用户能看出这次没生效。
 *
 * @param {object} props - 组件属性
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t - 翻译函数
 * @param {(method: string, args?: unknown[]) => Promise<unknown>} props.callRemote - 远端调用
 * @returns {object} React 元素
 */
function BoardModeSection({ t, callRemote }) {
  /** `loading` 时选项不可用；`error` 表示读不到宿主配置，需要重试。 */
  const [phase, setPhase] = useState('loading')
  const [mode, setMode] = useState(getBoardMode)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setMessage('')
    callRemote('readSettings', []).then((value) => {
      if (cancelled) return
      const next = normalizeBoardMode(value?.boardMode)
      setBoardMode(next)
      setMode(next)
      setPhase('ready')
    }).catch((error) => {
      if (cancelled) return
      setPhase('error')
      setMessage(t('board.settings.loadFailed', { message: errorText(error) }))
    })
    return () => { cancelled = true }
    // `t` 只用于失败文案，不进依赖：语言切换时重跑会再发一次取数。
  }, [attempt, callRemote])

  // 其它看板实例读回宿主配置后也会广播，设置页的选中态跟着走。
  useEffect(() => subscribeBoardMode(setMode), [])

  /**
   * 选中一个模式并保存到宿主。
   * @param {string} next - 目标模式
   * @returns {void}
   */
  function choose(next) {
    if (phase !== 'ready' || busy || next === mode) return
    setBusy(true)
    setMessage('')
    callRemote('setBoardMode', [next]).then((value) => {
      const applied = normalizeBoardMode(value?.boardMode)
      setBoardMode(applied)
      setMode(applied)
      setBusy(false)
    }).catch((error) => {
      setBusy(false)
      setMessage(t('board.settings.saveFailed', { message: errorText(error) }))
    })
  }

  const disabled = phase !== 'ready' || busy

  return createElement(
    'section',
    { className: 'dsh-leader-agent-settings-section dsh-leader-agent-settings-group', 'aria-labelledby': 'dsh-leader-agent-settings-board' },
    createElement('h3', {
      id: 'dsh-leader-agent-settings-board',
      className: 'dsh-leader-agent-settings-title',
    }, t('board.settings.title')),
    createElement('p', { className: 'dsh-leader-agent-settings-desc' }, t('board.settings.desc')),
    createElement(
      'div',
      {
        className: 'dsh-leader-agent-settings-options',
        role: 'radiogroup',
        'aria-label': t('board.settings.title'),
        'aria-busy': busy,
      },
      BOARD_MODES.map((value) => createElement(ModeOption, {
        key: value,
        value,
        mode,
        disabled,
        onChoose: choose,
        t,
      })),
    ),
    phase === 'error'
      ? createElement('div', { className: 'dsh-leader-agent-settings-retry-row' },
        createElement('span', { className: 'dsh-leader-agent-settings-error', role: 'alert' }, message),
        createElement('button', {
          type: 'button',
          className: 'dsh-leader-agent-settings-retry',
          onClick: () => setAttempt((value) => value + 1),
        }, t('board.settings.retry')))
      : null,
    phase === 'ready' && message !== ''
      ? createElement('p', { className: 'dsh-leader-agent-settings-error', role: 'alert' }, message)
      : null,
  )
}

/**
 * 「自动续行」分区：一行标题/说明 + 右侧输入框，编辑后自动保存。
 *
 * 没有保存按钮：输入停顿 600ms 或失焦即提交；写盘成功后在行下方显示绿色
 * 「保存成功」，失败则保留输入并就地报红。校验失败只报错、不提交。
 *
 * @param {object} props - 组件属性
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t - 翻译函数
 * @param {(method: string, args?: unknown[]) => Promise<unknown>} props.callRemote - 远端调用
 * @returns {object} React 元素
 */
function AutoResumeSection({ t, callRemote }) {
  /** `loading` 时输入不可用；`error` 表示读不到宿主配置，需要重试。 */
  const [phase, setPhase] = useState('loading')
  /** 已生效的值：保存成功后由宿主返回，作为「是否有改动」的基线。 */
  const [saved, setSaved] = useState(AUTO_RESUME_LIMIT_DEFAULT)
  /** 输入框里的草稿，保留用户正在敲的原始形态。 */
  const [draft, setDraft] = useState(String(AUTO_RESUME_LIMIT_DEFAULT))
  /** `idle` / `saving` / `saved` / `error` */
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  /** 读取失败后的重试计数：+1 触发同一个 effect 再跑一遍。 */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setStatus('idle')
    setMessage('')
    callRemote('readSettings', []).then((value) => {
      if (cancelled) return
      const limit = parseAutoResumeLimit(value?.autoResumeLimit)
      const effective = limit ?? AUTO_RESUME_LIMIT_DEFAULT
      setSaved(effective)
      setDraft(String(effective))
      setPhase('ready')
    }).catch((error) => {
      if (cancelled) return
      setPhase('error')
      setMessage(t('settings.autoResume.loadFailed', { message: errorText(error) }))
    })
    return () => { cancelled = true }
    // `t` 只用于失败文案，不进依赖：它随语言切换换引用时重跑会再发一次取数；
    // 设置页打开期间切语言，错误文案下一次重试自然用新语言。
  }, [attempt, callRemote])

  const limit = parseAutoResumeLimit(draft)
  const invalid = limit === undefined
  const dirty = limit !== undefined && limit !== saved

  /**
   * 提交当前草稿；同值、非法、读取中或保存中都不重复提交。
   * @param {string} value - 输入框草稿
   * @returns {void}
   */
  function commit(value) {
    if (phase !== 'ready' || status === 'saving') return
    const next = parseAutoResumeLimit(value)
    if (next === undefined || next === saved) return
    setStatus('saving')
    setMessage('')
    callRemote('updateAutoResumeLimit', [next]).then((result) => {
      const applied = parseAutoResumeLimit(result?.autoResumeLimit) ?? next
      setSaved(applied)
      setDraft(String(applied))
      setStatus('saved')
    }).catch((error) => {
      setStatus('error')
      setMessage(t('settings.autoResume.saveFailed', { message: errorText(error) }))
    })
  }

  // 输入停顿后自动保存；保存失败不自动重试，等用户再改或失焦/Enter。
  useEffect(() => {
    if (phase !== 'ready' || !dirty || status === 'saving' || status === 'error') return undefined
    const timer = setTimeout(() => { commit(draft) }, 600)
    return () => clearTimeout(timer)
    // `commit` 依赖 saved/status，函数每次渲染都会换；依赖收在真正会改变提交
    // 条件的值上，避免把它放进依赖后定时器每轮重建。
  }, [draft, phase, dirty, status, saved, callRemote])

  const describedBy = invalid ? 'dsh-leader-agent-auto-resume-error' : undefined

  return createElement(
    'section',
    { className: 'dsh-leader-agent-settings-section', 'aria-labelledby': 'dsh-leader-agent-settings-auto-resume' },
    createElement(
      'div',
      { className: 'dsh-leader-agent-settings-row' },
      createElement(
        'div',
        { className: 'dsh-leader-agent-settings-row-text' },
        createElement('h3', {
          id: 'dsh-leader-agent-settings-auto-resume',
          className: 'dsh-leader-agent-settings-subtitle',
        }, t('settings.autoResume.title')),
        createElement('p', { className: 'dsh-leader-agent-settings-desc' }, t('settings.autoResume.desc')),
      ),
      createElement(
        'div',
        { className: 'dsh-leader-agent-settings-control' },
        createElement('input', {
          id: 'dsh-leader-agent-auto-resume',
          className: 'dsh-leader-agent-settings-input',
          type: 'text',
          inputMode: 'numeric',
          pattern: '[0-9]*',
          maxLength: 5,
          value: draft,
          disabled: phase !== 'ready',
          readOnly: status === 'saving',
          'aria-label': t('settings.autoResume.title'),
          'aria-invalid': invalid,
          'aria-describedby': describedBy,
          onChange: (event) => {
            setDraft(event.target.value)
            setStatus('idle')
            setMessage('')
          },
          onBlur: () => { commit(draft) },
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            commit(draft)
          },
        }),
        createElement('span', { className: 'dsh-leader-agent-settings-unit' }, t('settings.autoResume.unit')),
      ),
    ),
    invalid
      ? createElement('p', {
        id: 'dsh-leader-agent-auto-resume-error',
        className: 'dsh-leader-agent-settings-error',
        role: 'alert',
      }, t('settings.autoResume.invalid', {
        min: AUTO_RESUME_LIMIT_MIN,
        max: AUTO_RESUME_LIMIT_MAX,
      }))
      : null,
    status === 'saved'
      ? createElement('p', {
        className: 'dsh-leader-agent-settings-saved',
        role: 'status',
      }, t('settings.autoResume.saved'))
      : null,
    status === 'error'
      ? createElement('p', { className: 'dsh-leader-agent-settings-error', role: 'alert' }, message)
      : null,
    phase === 'error'
      ? createElement('div', { className: 'dsh-leader-agent-settings-retry-row' },
        createElement('span', { className: 'dsh-leader-agent-settings-error' }, message),
        createElement('button', {
          type: 'button',
          className: 'dsh-leader-agent-settings-retry',
          onClick: () => setAttempt((value) => value + 1),
        }, t('settings.autoResume.retry')))
      : null,
  )
}

/**
 * 设置页主体：两块分区共享页面外壳，不混在同一组控件里。
 *
 * @param {object} props - 组件属性
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t - 翻译函数
 * @param {(method: string, args?: unknown[]) => Promise<unknown>} props.callRemote - 远端调用
 * @returns {object} React 元素
 */
function BoardSettingsSection({ t, callRemote }) {
  return createElement(
    'section',
    { className: 'dsh-leader-agent-settings' },
    createElement(BoardModeSection, { t, callRemote }),
    createElement(AutoResumeSection, { t, callRemote }),
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
  // 保持同一个函数引用：设置页的读取 effect 依赖它，槽位重渲染不该反复重读配置。
  const callRemote = (method, args = []) => callProjectRemote(ctx, method, args)
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: SECTION_ORDER,
    label: () => t('board.settings.nav'),
    inject: () => ({ t, callRemote }),
  }, BoardSettingsSection)), 'dsh-leader-agent 设置页')
}
