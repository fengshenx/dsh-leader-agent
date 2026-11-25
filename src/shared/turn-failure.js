/**
 * 把宿主 `turn/end` 的终态原因写成一句人能读的失败说明。
 *
 * 完成通知与 `read_worker_session` 必须显示同一条文本：只把 `kind` 存进回看，
 * 读者看到的是「aborted」这种裸标签，而通知里写着「被取消：user」——两条读面
 * 各写一份就会漂移，也凑不出「通知里有的，回看拿得到」。
 *
 * @module dsh-leader-agent/shared/turn-failure
 */

/**
 * @param {object} reason - `turn/end` 的 `reason`
 * @returns {string} 失败原因；`completed` 不应调用本函数
 */
export function describeTurnFailure(reason) {
  switch (reason?.kind) {
    // `aborted.reason` 是对象（`{ kind: 'user' | 'parent' | 'hook' | … }`），
    // 直接插值会渲染成 `[object Object]`——给读者看的就是这句原因。
    case 'aborted': return `被取消：${reason.reason?.kind ?? '未说明原因'}`
    case 'blocked': return '被阻断：这一轮被宿主拦下，没有开始'
    case 'max-tokens': return '输出达到 token 上限，这一轮没有正常收尾'
    case 'error': return reason.error?.message ?? '未知错误'
    default: return `这一轮没有正常结束（${reason?.kind ?? '未知原因'}）`
  }
}
