/**
 * Markdown 渲染：直接用宿主的 `MarkdownText`。
 *
 * `@deepseek-ai/dsh-client-ui-primitives` 是宿主 `PLATFORM_MODULES` 里的基线模块
 * （rc.2 起，与 react 同表），`seed.ts` 把它静态 import 进冻结模块表，所有 bundle
 * 的 `require` 解析到同一实例。宿主自己的聊天消息就用这个组件，这里复用它，不另
 * 带一份解析器，也不引第三方 Markdown 依赖。
 *
 * 两处调用点都在窄容器里（详情浮层、聊天气泡），因此固定 `variant: 'compact'`：
 * 13px 字号、统一粗细的标题、4px 块间距——`body` 变体是文档排版，标题与段间距会
 * 把气泡撑成文档页。
 *
 * `labels` 必须是引用稳定的对象：组件按身份判断是否重建流式渲染缓存，每帧新建
 * 一个对象会让缓存失效。故这里是模块级常量。
 *
 * @module dsh-leader-kit/client/markdown
 */

import { createElement } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

/** 渲染器自带的界面文案（代码块复制按钮）。本仓不做多语言，固定中文。 */
const MARKDOWN_LABELS = {
  code: {
    copyLabel: '复制',
    copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码', wrapLabel: '换行', unwrapLabel: '取消换行' },
  },
  footnotes: '脚注',
}

/**
 * 渲染 Markdown 原文。
 *
 * @param {object} props - 组件属性
 * @param {string} [props.source] - Markdown 原文
 * @param {'body' | 'compact'} [props.variant] - 排版变体
 * @returns {object | null} React 元素；原文为空时为 null
 */
export function Markdown({ source = '', variant = 'compact' }) {
  if (typeof source !== 'string' || source === '') return null
  return createElement(MarkdownText, { text: source, labels: MARKDOWN_LABELS, variant })
}
