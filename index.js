/**
 * dsh-leader-kit bundle 入口。
 *
 * bundle 只贡献一层插件配置（cordis.patch.yml），真正的实现从 src/host 载入。
 *
 * 插件行以**包名**注册（不是 `dsh-leader-kit/src/host` 这样的子路径）：浏览器侧
 * 靠 Loader 行名定位包 manifest，才能发现本包的 client 半边；子路径行定位不到
 * 包根，宿主便不会把 client bundle 下发给浏览器。
 *
 * @module dsh-leader-kit
 */

export { apply, inject, name } from './src/host/index.js'
