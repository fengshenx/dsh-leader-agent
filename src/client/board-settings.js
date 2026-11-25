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
 * 模式选项的小预览图。
 *
 * 只是示意：用两个 SVG 画出「主干 + 节点」与「三行列表」，让用户在点之前就能
 * 分辨两个模式。图形颜色走 currentColor，执行者圆点取宿主强调色（不写死琥珀：
 * 浅色宿主的 accent 是蓝的，固定琥珀会与看板实际配色对不上），一起跟随主题。
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
      createElement('circle', { cx: 36, cy: 9, r: 2.6, className: 'dsh-leader-agent-settings-preview-dot' }),
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
      className: selected
        ? 'dsh-leader-agent-settings-option dsh-leader-agent-settings-option-selected'
        : 'dsh-leader-agent-settings-option',
      disabled,
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
    { className: 'dsh-leader-agent-settings-section', 'aria-labelledby': 'dsh-leader-agent-settings-board' },
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
          className: 'dsh-leader-agent-settings-button',
          onClick: () => setAttempt((value) => value + 1),
        }, t('board.settings.retry')))
      : null,
    phase === 'ready' && message !== ''
      ? createElement('p', { className: 'dsh-leader-agent-settings-error', role: 'alert' }, message)
      : null,
    createElement('p', { className: 'dsh-leader-agent-settings-scope' }, t('board.settings.scope')),
  )
}

/**
 * 「自动续行」分区：宿主侧护栏，保存在当前 dsh 数据根，所有项目共用。
 *
 * 输入在提交时校验；保存成功后只更新本地快照，不做乐观更新——写盘失败时界面
 * 必须显示旧值仍然生效，否则用户会以为改成功了。
 *
 * @param {object} props - 组件属性
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t - 翻译函数
 * @param {(method: string, args?: unknown[]) => Promise<unknown>} props.callRemote - 远端调用
 * @returns {object} React 元素
 */
function AutoResumeSection({ t, callRemote }) {
  /** `loading` 时表单不可用；`error` 表示读不到宿主配置，需要重试。 */
  const [phase, setPhase] = useState('loading')
  /** 已生效的值：保存成功后由宿主返回，作为「是否有改动」的基线。 */
  const [saved, setSaved] = useState(AUTO_RESUME_LIMIT_DEFAULT)
  /** 输入框里的草稿（字符串），保留用户正在敲的原始形态。 */
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
  const busy = phase !== 'ready' || status === 'saving'

  /**
   * 提交表单：Enter 与「保存」按钮走同一条路径。
   * @param {object} event - 表单提交事件
   * @returns {void}
   */
  function submit(event) {
    event.preventDefault()
    if (phase !== 'ready' || status === 'saving') return
    if (limit === undefined) return
    if (limit === saved) return
    setStatus('saving')
    setMessage('')
    callRemote('updateAutoResumeLimit', [limit]).then((value) => {
      const next = parseAutoResumeLimit(value?.autoResumeLimit) ?? limit
      setSaved(next)
      setDraft(String(next))
      setStatus('saved')
    }).catch((error) => {
      setStatus('error')
      setMessage(t('settings.autoResume.saveFailed', { message: errorText(error) }))
    })
  }

  const describedBy = invalid
    ? 'dsh-leader-agent-auto-resume-hint dsh-leader-agent-auto-resume-error'
    : 'dsh-leader-agent-auto-resume-hint'

  return createElement(
    'section',
    { className: 'dsh-leader-agent-settings-section', 'aria-labelledby': 'dsh-leader-agent-settings-auto-resume' },
    createElement('h3', {
      id: 'dsh-leader-agent-settings-auto-resume',
      className: 'dsh-leader-agent-settings-subtitle',
    }, t('settings.autoResume.title')),
    createElement('p', { className: 'dsh-leader-agent-settings-desc' }, t('settings.autoResume.desc')),
    createElement(
      'form',
      { className: 'dsh-leader-agent-settings-field', onSubmit: submit, noValidate: true },
      createElement('label', {
        className: 'dsh-leader-agent-settings-label',
        htmlFor: 'dsh-leader-agent-auto-resume',
      }, t('settings.autoResume.label')),
      createElement(
        'div',
        { className: 'dsh-leader-agent-settings-field-row' },
        createElement('input', {
          id: 'dsh-leader-agent-auto-resume',
          className: 'dsh-leader-agent-settings-input',
          type: 'number',
          min: AUTO_RESUME_LIMIT_MIN,
          max: AUTO_RESUME_LIMIT_MAX,
          step: 1,
          inputMode: 'numeric',
          value: draft,
          disabled: busy,
          'aria-invalid': invalid,
          'aria-describedby': describedBy,
          onChange: (event) => {
            setDraft(event.target.value)
            setStatus('idle')
            setMessage('')
          },
        }),
        createElement('button', {
          type: 'submit',
          className: 'dsh-leader-agent-settings-button',
          disabled: busy || !dirty || invalid,
        }, t(status === 'saving' ? 'settings.autoResume.saving' : 'settings.autoResume.save')),
      ),
      createElement('p', {
        id: 'dsh-leader-agent-auto-resume-hint',
        className: 'dsh-leader-agent-settings-hint',
      }, t('settings.autoResume.hint', {
        default: AUTO_RESUME_LIMIT_DEFAULT,
        min: AUTO_RESUME_LIMIT_MIN,
        max: AUTO_RESUME_LIMIT_MAX,
      })),
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
            className: 'dsh-leader-agent-settings-button',
            onClick: () => setAttempt((value) => value + 1),
          }, t('settings.autoResume.retry')))
        : null,
    ),
    createElement('p', { className: 'dsh-leader-agent-settings-scope' }, t('settings.autoResume.scope')),
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
