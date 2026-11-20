/**
 * Markdown 渲染：直接用宿主的 `MarkdownText`。
 *
 * `@deepseek-ai/dsh-client-ui-primitives` 是宿主 `PLATFORM_MODULES` 里的基线模块
 * （rc.2 起，与 react 同表），`seed.ts` 把它静态 import 进冻结模块表，所有 bundle
 * 的 `require` 解析到同一实例。宿主自己的聊天消息就用这个组件，这里复用它，不另
 * 带一份解析器，也不引第三方 Markdown 依赖。
 *
 * 调用点都在窄容器里（详情浮层、worker 回报气泡、任务气泡），因此固定 `variant: 'compact'`：
 * 13px 字号、统一粗细的标题、4px 块间距——`body` 变体是文档排版，标题与段间距会
 * 把气泡撑成文档页。
 *
 * `labels` 必须是引用稳定的对象：组件按身份判断是否重建流式渲染缓存，每帧新建
 * 一个对象会让缓存失效。按文案内容做一份模块级缓存——同一语言内所有渲染共用同一
 * 个对象，切换语言后内容变了才换新对象。
 *
 * @module dsh-leader-agent/client/markdown
 */

import { createElement } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

/** 文案内容到 labels 对象的缓存：同一语言内保持引用稳定。 */
const LABEL_CACHE = new Map()

/**
 * 取当前语言的渲染器 labels。
 *
 * @param {(key: string, params?: Record<string, unknown>) => string} t - 当前语言的翻译函数
 * @returns {object} 引用稳定的 labels
 */
function markdownLabels(t) {
  const copyLabel = t('markdown.copy')
  const copiedLabel = t('markdown.copied')
  const codeLabel = t('markdown.code')
  const wrapLabel = t('markdown.wrap')
  const unwrapLabel = t('markdown.unwrap')
  const footnotes = t('markdown.footnotes')
  const key = [copyLabel, copiedLabel, codeLabel, wrapLabel, unwrapLabel, footnotes].join('\u0000')
  const cached = LABEL_CACHE.get(key)
  if (cached !== undefined) return cached
  const labels = Object.freeze({
    code: Object.freeze({
      copyLabel,
      copiedLabel,
      toolbarLabels: Object.freeze({ codeLabel, wrapLabel, unwrapLabel }),
    }),
    footnotes,
  })
  LABEL_CACHE.set(key, labels)
  return labels
}

/**
 * 渲染 Markdown 原文。
 *
 * @param {object} props - 组件属性
 * @param {string} [props.source] - Markdown 原文
 * @param {'body' | 'compact'} [props.variant] - 排版变体
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t - 当前语言的翻译函数
 * @returns {object | null} React 元素；原文为空时为 null
 */
export function Markdown({ source = '', variant = 'compact', t }) {
  if (typeof source !== 'string' || source === '') return null
  return createElement(MarkdownText, { text: source, labels: markdownLabels(t), variant })
}
