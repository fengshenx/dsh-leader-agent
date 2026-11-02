/**
 * 客户端产物的构建核心。入口 `build/client.mjs` 只负责解析命令行与定位路径，
 * 判定与构建步骤都在这里，便于单测直接跑一次真实构建。
 *
 * 产物契约（closure-factory）：首行注册 `window.__ModuleLoader__.load({ id, factory })`，
 * 末行把 exports 交回工厂；React、react-dom 与基线宿主包必须 external，由宿主模块表
 * 提供同一份实例，打进产物会出现第二份 React、hooks 失效（基线宿主包见下）。
 *
 * 写入是原子的：esbuild 先写 `<产物>.<pid>.<随机>.staging`，成功后才 rename 到正式
 * 路径。宿主 `client-hmr` 每 500ms 按 `mtime/ctime/size` 轮询该文件，读到变化就替换
 * 运行中的插件——它没有失败回滚，读到半截文件会让插件直接失效。构建失败时正式产物
 * 保持上一份完整内容，自己的 staging 清掉。
 *
 * staging 带进程标识：同树里 watcher 与手动构建并存时，两个进程不会共写同一个临时
 * 文件（共享路径会让先完成的 rename 把另一个正在写的路径搬走）。各自 rename 仍会竞争
 * 最终产物，后完成者赢——不保证内容新旧顺序，但读方永远看不到半截文件。
 *
 * @module dsh-leader-kit/build/client-bundle
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { context } from 'esbuild'

/**
 * 宿主平台基线模块（`packages/client/web/src/platform.ts` 的 PLATFORM_MODULES）。
 * 产物必须把它们留在外面，运行时由宿主模块表提供同一份实例。
 *
 * rc.2 的 `PLATFORM_MODULES` 里有四个宿主自有包（`dsh-client-store`、`dsh-client-ui-slots`、
 * `dsh-client-ui-primitives`、`dsh-client-ui-dockkit`），本仓只用到 `ui-primitives`：
 * Markdown 渲染用它，宿主聊天消息用的也是同一份实例。留在产物外面才不会打出第二份实现。
 *
 * 这张表是宿主侧的版本耦合面：条目由 `seed.ts` 静态 import、两边由 satisfies 钉住，
 * 但宿主可以随版本增删，没有跨版本承诺。`engines.dsh` 下限变更或升级宿主时，先对照
 * 该 tag 的 `platform.ts` 复核 `ui-primitives` 是否还在表里——不在表里时产物里的
 * 外部 require 会解析失败，插件客户端半边整个起不来。
 */
const BASELINE_EXTERNALS = ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

/** 产物注册到宿主模块表时用的 id：必须与包名一致（宿主按包名索引插件行）。 */
const PLUGIN_ID = 'dsh-leader-kit'

const BANNER = `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`

const FOOTER = 'return module.exports; } });'

/**
 * 解析 `build/client.mjs` 的命令行参数。
 *
 * @param {string[]} argv - `process.argv.slice(2)`
 * @returns {{ watch: boolean }} 构建选项
 * @throws {Error} 传入未知参数时
 */
export function parseBuildArgs(argv) {
  let watch = false
  for (const arg of argv) {
    if (arg === '--watch') {
      watch = true
      continue
    }
    throw new Error(`未知参数: ${arg}（只支持 --watch）`)
  }
  return { watch }
}

/**
 * 构建客户端产物。
 *
 * `watch` 为 true 时常驻监听源文件变化并重建，首次构建失败不会抛错（esbuild
 * 打印错误后继续监听）；`watch` 为 false 时构建一次，失败抛错。
 *
 * @param {object} options - 构建选项
 * @param {string} options.entry - 客户端入口文件绝对路径
 * @param {string} options.outfile - 产物绝对路径
 * @param {boolean} [options.watch] - 是否常驻监听
 * @param {'warning' | 'silent'} [options.logLevel] - esbuild 日志级别，预期失败的用例可关掉输出
 * @returns {Promise<{ initialBuildFailed: boolean }>} 首次构建是否失败（watch 模式下用来区分「监听已建立」与「产物可用」）
 */
export async function buildClient({ entry, outfile, watch = false, logLevel = 'warning' }) {
  const staging = `${outfile}.${process.pid}.${randomBytes(4).toString('hex')}.staging`
  mkdirSync(dirname(outfile), { recursive: true })

  let initialBuildFailed = false
  let firstBuild = true
  let resolveFirstBuild
  // `ctx.watch()` resolve 时首次构建的 onEnd 可能还没跑（实测），入口据此打提示
  // 前必须等首次构建真正结束。
  const firstBuildDone = new Promise((resolve) => { resolveFirstBuild = resolve })

  const ctx = await context({
    entryPoints: [entry],
    outfile: staging,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: BASELINE_EXTERNALS,
    banner: { js: BANNER },
    footer: { js: FOOTER },
    plugins: [{
      name: 'dsh-leader-kit-atomic-write',
      setup(build) {
        build.onEnd((result) => {
          const failed = result.errors.length > 0
          if (firstBuild) {
            firstBuild = false
            initialBuildFailed = failed
            resolveFirstBuild()
          }
          if (failed) {
            // 当前 esbuild 失败时不写 staging，这行是为将来版本留的防御。
            rmSync(staging, { force: true })
            return
          }
          renameSync(staging, outfile)
        })
      },
    }],
    logLevel,
  })

  if (!watch) {
    try {
      await ctx.rebuild()
    } finally {
      await ctx.dispose()
    }
    return { initialBuildFailed }
  }

  await ctx.watch()
  await firstBuildDone
  return { initialBuildFailed }
}
