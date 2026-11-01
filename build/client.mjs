/**
 * 构建客户端半边产物。
 *
 * 宿主按 closure-factory 约定加载 `lib/client.js`：工厂把自己的 require 交给
 * 产物，产物用它解析宿主提供的模块行。dsh 自带的 `clientBundle` 预设绑定仓内
 * 多个模块，第三方仓无法直接引用，因此这里用 esbuild 复刻那一层封装：
 * 产物体是 CJS，banner 注册工厂并注入 require，footer 交回 exports。
 *
 * 外部模块保持 import，由工厂的 require 解析；其余依赖打进产物。React 与
 * react-dom 必须 external：它们是宿主平台基线模块（`PLATFORM_MODULES`），
 * 打进产物会出现第二份 React 实例，hooks 随之失效。
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/**
 * 宿主平台基线模块（`packages/client/web/src/platform.ts` 的 PLATFORM_MODULES）。
 * 产物必须把它们留在外面，运行时由宿主模块表提供同一份实例。
 */
const BASELINE_EXTERNALS = ['react', 'react-dom']

const id = 'dsh-leader-kit'

await build({
  entryPoints: [join(root, 'src/client/index.js')],
  outfile: join(root, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: BASELINE_EXTERNALS,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'warning',
})
