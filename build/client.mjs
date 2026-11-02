/**
 * 构建客户端半边产物。
 *
 * 宿主按 closure-factory 约定加载 `lib/client.js`：工厂把自己的 require 交给
 * 产物，产物用它解析宿主提供的模块行。dsh 自带的 `clientBundle` 预设绑定仓内
 * 多个模块，第三方仓无法直接引用，因此这里用 esbuild 复刻那一层封装。
 *
 * `--watch` 常驻重建：宿主 web 组合默认挂着 `client-hmr`，它按文件 stat 轮询
 * 每个插件行的 client 产物，写完就把运行中的插件换掉——不需要刷新页面。
 * 构建配置、基线模块清单与原子写都在 `client-bundle.mjs`。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClient, parseBuildArgs } from './client-bundle.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let watch
try {
  ({ watch } = parseBuildArgs(process.argv.slice(2)))
} catch (error) {
  console.error(`错误: ${error.message}`)
  process.exit(1)
}

const { initialBuildFailed } = await buildClient({
  entry: join(root, 'src/client/index.js'),
  outfile: join(root, 'lib/client.js'),
  watch,
})

if (watch) {
  if (initialBuildFailed) {
    console.error('客户端 watch 已建立，但首次构建失败：修好源码后会自动重建，正式产物保持上一份')
  } else {
    console.log('客户端 watch 已建立：改 src/client/ 自动重建，宿主 client-hmr 会替换运行中的插件')
  }
}
