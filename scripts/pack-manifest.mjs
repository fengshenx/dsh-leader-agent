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
 * `.agents/` 下唯一该发布的子树：协议层 skill。
 *
 * 这个目录同时住着仓内上下文（`notes/` 的决策记忆、将来的 `prompts/` 之类）与要发布
 * 的 skill，所以按「只放行 skills 前缀」正向判定，而不是逐条禁止：新增 `.agents/<目录>`
 * 时默认被拦，漏写一条规则不会让文件静默进用户 `node_modules`。
 */
export const AGENTS_SKILLS_PREFIX = '.agents/skills/'

/**
 * 不该出现在发布包里的路径。
 *
 * 每条都对应一个具体的漂移风险：测试把仓内上下文带进用户的 node_modules；`scripts/`
 * 与 `build/` 是开发工具，装了也用不上；`.dev/`、`.worktrees/`、`.telov/` 是本地运行态
 * 与工作区运维资产（发版 skill 之类，只服务本仓维护者）；`.tgz` 与 `.DS_Store` 是打包
 * 过程与 macOS 的残留。
 *
 * 这份名单是 `files` 白名单的补集，不是它的复述：白名单一旦放宽（比如有人写
 * `"docs/**"`、`"*.md"`），这里负责把不该发的东西拦下来。`.agents/` 例外，走
 * `isForbiddenPath` 的允许面。仓根提示词两个名字都拦：`LEADER.md` 是当前名，
 * `COORDINATOR.md` 只剩指向它的兼容入口，都是仓内上下文。
 */
export const FORBIDDEN_PATTERNS = Object.freeze([
  /(^|\/)tests\//,
  /^\.dev\//,
  /^\.worktrees\//,
  /^\.telov\//,
  /^\.github\//,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^SLOTS\.md$/,
  /^LEADER\.md$/,
  /^COORDINATOR\.md$/,
  /^docs\//,
  /^scripts\//,
  /^build\//,
  /^node_modules\//,
  /(^|\/)\.DS_Store$/,
  /\.tgz$/,
])

/**
 * 判定一条包内路径是否不该发布。
 * @param {string} path - 包内 POSIX 相对路径
 * @returns {boolean} 不该出现时为 true
 */
export function isForbiddenPath(path) {
  if (path.startsWith('.agents/') && !path.startsWith(AGENTS_SKILLS_PREFIX)) return true
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(path))
}

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
 * `files` 里的固定路径也并进必需集：白名单写了 `README_ZH.md` 而文件已改名的场合，
 * npm 不报错、只是不带它，门禁照绿。通配条目（`src/**`）不展开——它们的覆盖面由
 * `exports` 推导与装机 smoke 兜住。
 *
 * @param {object} options - 输入
 * @param {object} options.manifest - `package.json` 内容
 * @param {string[]} options.skillFiles - `.agents/skills/` 下的全部文件（包内相对路径）
 * @param {string[]} options.localeFiles - `locale/*.json` 文件名（不含目录）
 * @returns {string[]} 必须存在的包内相对路径
 */
export function requiredPackFiles({ manifest, skillFiles, localeFiles }) {
  const declared = Array.isArray(manifest.files)
    ? manifest.files.filter((path) => typeof path === 'string' && !path.includes('*'))
    : []
  const entries = [
    ...ALWAYS_SHIPPED,
    ...declared,
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
 * @param {(path: string) => boolean} [options.forbidden] - 不该出现的路径判定
 * @returns {{missing: string[], forbidden: string[]}} 缺失的必需文件与不该出现的文件
 */
export function checkPackEntries({ entries, required, forbidden = isForbiddenPath }) {
  const present = new Set(entries)
  return {
    missing: required.filter((path) => !present.has(path)),
    forbidden: entries.filter((path) => forbidden(path)),
  }
}
