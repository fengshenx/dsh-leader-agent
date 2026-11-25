/**
 * 客户端样式表的注入与刷新。
 *
 * 宿主 HMR 换插件时不刷新页面，上一个插件实例插进 `<head>` 的 `<style>` 仍在：
 * 只按 id 判重会让新版本改过的规则停在旧文本上（升级后新加的类名拿不到任何样式）。
 * 因此已存在时按内容同步，而不是直接返回。
 *
 * @module dsh-leader-agent/client/style-sheet
 */

/**
 * 注入样式表；同 id 的样式表已存在时就地刷新内容。
 *
 * 内容未变时不碰 DOM；`text` 是各模块的常量字符串，同一实例内重复调用命中的是
 * 同一条规则，比较代价只跟这项检查有关。
 *
 * @param {string} id - 样式表节点 id，同一页面内唯一
 * @param {string} text - 当前版本的样式表内容
 * @returns {void}
 */
export function ensureStyleSheet(id, text) {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(id)
  if (existing !== null) {
    if (existing.textContent !== text) existing.textContent = text
    return
  }
  const style = document.createElement('style')
  style.id = id
  style.textContent = text
  document.head.append(style)
}
