/**
 * 卡片详情浮层的内容分段。
 *
 * 展示什么由卡片决定：说明与链接。哪几段该出现、链接能不能编辑是纯判定，拆出来
 * 是为了能直接断言「没有说明就不出现说明段」，而不是靠肉眼数 DOM。
 *
 * @module dsh-leader-agent/client/card-detail-view
 */

/** 卡片没写说明时的占位文案。 */
export const DETAIL_SPEC_EMPTY = '这张卡还没有写说明。'

/**
 * 状态徽章文案。
 *
 * @param {string} status - 卡片状态
 * @returns {string} 徽章文案
 */
export function statusLabel(status) {
  if (status === 'done') return '已完成'
  if (status === 'archived') return '已归档'
  return '进行中'
}

/**
 * 详情浮层的分段内容。
 *
 * @param {object} card - 卡片
 * @returns {{ spec: string | null, links: object[] }} 分段
 */
export function detailSections(card) {
  const spec = typeof card?.spec === 'string' && card.spec !== '' ? card.spec : null
  return {
    spec,
    links: Array.isArray(card?.links) ? card.links : [],
  }
}

/**
 * 链接能否在详情里编辑。
 *
 * 归档是终态，卡片库会拒改；界面不给出一个必然失败的入口。已完成卡可改——
 * 收尾后发现漏挂链接是常态。
 *
 * @param {object} card - 卡片
 * @returns {boolean} 能否编辑
 */
export function canEditCardLinks(card) {
  return card?.status !== 'archived'
}

/**
 * 详情里能否删除这张卡。
 *
 * 只防没有 id 的脏数据：删一个空 id 既定位不到卡，也只会换回一条必然失败的
 * 远程错误。不按状态拦——归档卡不在看板渲染（看板只渲染 active / done），
 * 正常路径到不了详情；判据只认 id。
 *
 * @param {object} card - 卡片
 * @returns {boolean} 能否删除
 */
export function canDeleteCard(card) {
  return typeof card?.id === 'string' && card.id !== ''
}

/**
 * 删除确认框的说明文字。
 *
 * @param {object} card - 卡片
 * @returns {string} 说明文字
 */
export function describeCardRemoval(card) {
  const number = card?.number ?? '?'
  const title = card?.title ?? ''
  return `将删除卡片 #${number}「${title}」。删除后不可恢复，编号不会再分配，卡片上的槽位绑定会一并解除。`
}
