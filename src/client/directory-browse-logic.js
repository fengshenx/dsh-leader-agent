/**
 * 应用内目录浏览的纯逻辑。
 *
 * 宿主在 linux 缺 chooser、无 display、SSH 启动或非 loopback bind 时组合的是
 * `browse` 选择器；插件不能读宿主的 `capability()`，只能靠 `listDirectory` 的
 * 成功/拒绝判断当前宿主服务哪一种。这里只放与渲染无关、单测能覆盖的判定。
 *
 * @module dsh-leader-agent/client/directory-browse-logic
 */

/**
 * 面包屑显示链。
 *
 * 与宿主目录浏览器一致：落在主目录子树里时从本地化的「主目录」开始，不把
 * `/Users/mxwu` 这类完整祖先链铺开；落在主目录之外时保留完整祖先链，根节点用
 * 它自己的路径当标签。宿主的 entries/crumbs 都带绝对路径，客户端不拼路径。
 *
 * @param {object} listing - 宿主的 DirectoryListing
 * @param {string} homeLabel - 主目录的本地化标签
 * @returns {object[]} 可点击的面包屑（`{ name, path, hidden }`）
 */
export function displayCrumbs(listing, homeLabel) {
  const homeIndex = listing.crumbs.findIndex((crumb) => crumb.path === listing.home)
  if (homeIndex === -1) return listing.crumbs
  return [
    { name: homeLabel, path: listing.home, hidden: false },
    ...listing.crumbs.slice(homeIndex + 1),
  ]
}

/**
 * 列表里实际渲染的子目录。
 *
 * 隐藏目录（点开头的名字）默认不显示：项目目录几乎不会是隐藏目录，铺开
 * `.cache` / `.local` 只是噪声。用户显式勾选时全部显示。
 *
 * @param {object[]} entries - listing.entries
 * @param {boolean} showHidden - 是否显示隐藏目录
 * @returns {object[]} 要渲染的条目
 */
export function visibleEntries(entries, showHidden) {
  return showHidden ? entries : entries.filter((entry) => entry.hidden !== true)
}

/**
 * 当前目录的上一级面包屑。
 *
 * 显示链在主目录处截断（与宿主一致），但 `listing.crumbs` 始终带完整祖先链，
 * 所以上一级用它算——不拼路径：宿主的 entries/crumbs 都带绝对路径，客户端只
 * 转发主机给的值。已到根（只有一条 crumb）时返回 null。
 *
 * @param {object} listing - 宿主的 DirectoryListing
 * @returns {object | null} 上一级面包屑
 */
export function parentCrumb(listing) {
  const { crumbs } = listing
  return crumbs.length > 1 ? crumbs[crumbs.length - 2] : null
}

/**
 * 目录操作的失败文案。
 *
 * `DirectoryBrowseError` 把宿主业务错误放在 `rpcError.message`，`message` 只是
 * `directory browse failed: <code>: <message>` 的诊断串；界面优先用业务文案。
 *
 * @param {unknown} error - list/create 的拒绝原因
 * @returns {string} 展示给用户的文案
 */
export function directoryBrowseFailureText(error) {
  const rpcError = error !== null && typeof error === 'object' ? error.rpcError : undefined
  if (rpcError !== null && typeof rpcError === 'object' && typeof rpcError.message === 'string' && rpcError.message !== '') {
    return rpcError.message
  }
  return error instanceof Error ? error.message : String(error)
}
