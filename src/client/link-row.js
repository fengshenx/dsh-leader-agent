/**
 * 链接 chip 的判定与排布计划。
 *
 * 卡面与详情浮层两处都用链接 chip：卡面按实测宽度排布（放不下的收进「+N」），
 * 详情平铺全部。两者共享「哪些链接能跳转」与「chip 的 React key」两条判定——
 * 各写一份就会出现卡面能跳、详情不能跳，或两处 key 规则不一致。
 *
 * @module dsh-leader-kit/client/link-row
 */

import { isHttpUrl } from '../shared/card-links.js'

/**
 * 链接能否跳转。
 *
 * 只有 http(s) 的用 `<a>` 新标签打开，其余渲染成文字（点它开详情）。渲染层也
 * 要认 scheme：三条写入路径现在都只认 http(s)，但**存量卡**是校验上线前写进去
 * 的，可能带 `javascript:`；这里一旦拼进 `href` 就是可执行的注入面。
 *
 * @param {object} link - 链接
 * @returns {boolean} 能否跳转
 */
export function isJumpableLink(link) {
  return isHttpUrl(link?.url)
}

/**
 * chip 的 React key。
 *
 * 链接的 `id` 可选，标签又允许重复（`linkSchema` 只要求 `label`），两样都拿来做
 * key 会在标签重复时撞车。缺 id 时用标签加序号兜底。
 *
 * @param {object} link - 链接
 * @param {number} index - 链接在整行里的序号
 * @returns {string} React key
 */
export function linkRowKey(link, index) {
  if (typeof link?.id === 'string' && link.id !== '') return link.id
  return `${link?.label ?? ''}-${index}`
}

/**
 * 链接行的渲染计划。
 *
 * @param {object[]} links - 链接列表
 * @param {number} visibleCount - 实测算出的可见 chip 数
 * @returns {{ measureOverflow: string, visible: object[], overflow: string | null }} 计划
 */
export function planLinkRow(links, visibleCount) {
  const count = Number.isFinite(visibleCount)
    ? Math.min(Math.max(Math.trunc(visibleCount), 0), links.length)
    : links.length
  return {
    // 测量层的「+N」取上界：实际收起几个要等排布结果出来才知道，只能按最坏情况
    // 留位——宁可少露一个 chip，也不能让「+N」被挤出可视区
    measureOverflow: `+${links.length}`,
    visible: links.slice(0, count),
    overflow: count < links.length ? `+${links.length - count}` : null,
  }
}
