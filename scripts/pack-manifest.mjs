/**
 * 发布包内容的判定规则。
 *
 * 收录规则不复刻：真正的文件清单由 `npm pack --dry-run --json` 给出（`files`
 * 白名单、npm 内置排除、dot 目录的行为都在那里生效）。这里只判定两件事——该进包
 * 的进没进、不该进包的进没进。
 *
 * 读盘、跑 npm 与报数在 `verify-pack.mjs`。
 */

/**
 * 不该出现在发布包里的路径。
 *
 * 每条都对应一个具体的漂移风险：测试与决策笔记把仓内上下文带进用户的 node_modules
 * （`AGENTS.md` 里还写着本机凭据布局）；`scripts/` 与 `build/` 是开发工具，装了也
 * 用不上；`.dev/`、`.worktrees/` 是本地运行态；`.tgz` 与 `.DS_Store` 是打包过程与
 * macOS 的残留。
 *
 * 这份名单是 `files` 白名单的补集，不是它的复述：白名单一旦放宽（比如有人写
 * `"docs/**"`、`"*.md"`），这里负责把不该发的东西拦下来。
 */
export const FORBIDDEN_PATTERNS = Object.freeze([
  /(^|\/)tests\//,
  /^\.agents\/notes\//,
  /^\.agents\/[^/]+\.md$/,
  /^\.dev\//,
  /^\.worktrees\//,
  /^\.github\//,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^SLOTS\.md$/,
  /^COORDINATOR\.md$/,
  /^docs\//,
  /^scripts\//,
  /^build\//,
  /^node_modules\//,
  /(^|\/)\.DS_Store$/,
  /\.tgz$/,
])

/** npm 强制随包发布的文件，与 `files` 白名单无关。 */
const ALWAYS_SHIPPED = Object.freeze(['package.json', 'README.md', 'LICENSE'])

/**
 * 从 `exports` 取具体文件路径（跳过通配子路径，它们的覆盖面由磁盘枚举补齐）。
 * @param {unknown} exportsField - `package.json` 的 `exports`
 * @returns {string[]} 相对路径
 */
function exportFiles(exportsField) {
  if (typeof exportsField === 'string') return [exportsField]
  if (typeof exportsField !== 'object' || exportsField === null) return []
  return Object.entries(exportsField).flatMap(([key, value]) => {
    if (key.includes('*')) return []
    return exportFiles(value)
  })
}

/**
 * 把 `./x/y.js` 规整成 `x/y.js`。
 * @param {string} path - `package.json` 里的相对路径
 * @returns {string} 包内 POSIX 相对路径
 */
function normalize(path) {
  return path.replace(/^\.\//, '')
}

/**
 * 发布包必须包含的文件。
 *
 * 入口集从 `package.json` 推导（`main`、`exports`、`dsh.bundle.patch`），避免在门禁里
 * 抄一份会漂移的清单：改了入口忘了改门禁，门禁照绿而用户装到残缺的包。skill 与
 * locale 的覆盖面由磁盘枚举给出——`exports` 里的 `./locale/*.json` 是通配，取不到
 * 具体文件名。
 *
 * @param {object} options - 输入
 * @param {object} options.manifest - `package.json` 内容
 * @param {string[]} options.skillFiles - `.agents/skills/` 下的全部文件（包内相对路径）
 * @param {string[]} options.localeFiles - `locale/*.json` 文件名（不含目录）
 * @returns {string[]} 必须存在的包内相对路径
 */
export function requiredPackFiles({ manifest, skillFiles, localeFiles }) {
  const entries = [
    ...ALWAYS_SHIPPED,
    manifest.main,
    manifest.dsh?.bundle?.patch,
    ...exportFiles(manifest.exports),
    ...localeFiles.map((name) => `locale/${name}`),
    ...skillFiles,
  ].filter((path) => typeof path === 'string' && path !== '')

  return [...new Set(entries.map(normalize))].sort()
}

/**
 * 判定一次打包结果。
 *
 * @param {object} options - 输入
 * @param {string[]} options.entries - tarball 内的文件路径
 * @param {string[]} options.required - 必须存在的路径
 * @param {RegExp[]} [options.forbidden] - 不该出现的路径匹配
 * @returns {{missing: string[], forbidden: string[]}} 缺失的必需文件与不该出现的文件
 */
export function checkPackEntries({ entries, required, forbidden = FORBIDDEN_PATTERNS }) {
  const present = new Set(entries)
  return {
    missing: required.filter((path) => !present.has(path)),
    forbidden: entries.filter((path) => forbidden.some((pattern) => pattern.test(path))),
  }
}
