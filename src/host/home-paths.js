/**
 * 数据根解析：与宿主 `@deepseek-ai/dsh-home-paths` 的 `DSH_HOME` 口径对齐。
 *
 * 本 bundle 的数据写在宿主的 dsh home 下。两边算出的根不一致时，症状是数据写到
 * 别处、或读不到已有数据，所以这里照抄宿主的规则（rc.2 与 rc.5 逐字相同）：
 * 空或纯空白的 `DSH_HOME` 按未设处理；`~`、`~/`、`~\` 前缀按家目录展开；其余值
 * 一律 `resolve`——相对路径按进程 cwd、去掉末尾分隔符、归一化 `.` 与 `..`。
 *
 * 不 import 宿主包：`engines.dsh` 只承诺版本范围，内部包会随版本漂移。
 *
 * @module dsh-leader-kit/host/home-paths
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 默认数据根在用户主目录下的目录名，与宿主一致。 */
const DSH_HOME_DIR_NAME = '.dsh'

/**
 * 按宿主 `expandHomePath` 语义展开 `~` 前缀并解析成绝对路径。
 *
 * 只认单独的 `~` 与 `~/`、`~\` 前缀；`~user/x` 不展开，按普通相对路径解析——
 * 宿主也是这个结果（落到 `<cwd>/~user/x`）。
 *
 * @param {string} input - 原始路径
 * @param {string} homeDir - 用户主目录
 * @param {string} [cwd] - 相对路径的基准，默认 `process.cwd()`
 * @returns {string} 绝对路径
 */
export function expandHomePath(input, homeDir, cwd = process.cwd()) {
  const raw = String(input ?? '')
  const expanded = raw === '~'
    ? homeDir
    : raw.startsWith('~/') || raw.startsWith('~\\') ? join(homeDir, raw.slice(2)) : raw
  return resolve(cwd, expanded)
}

/**
 * 解析 dsh home 目录。
 *
 * @param {object} [env] - 环境变量映射（只读 `DSH_HOME`）
 * @param {() => string} [resolveHome] - 家目录解析器，默认 `os.homedir()`
 * @returns {string} dsh home 绝对路径
 */
export function resolveDshHome(env = process.env, resolveHome = homedir) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME : ''
  // 宿主只用 trim 判空、取值仍用原值：带首尾空白时它算的是另一条路径，照抄才不分叉。
  if (configured.trim() === '') return resolve(join(resolveHome(), DSH_HOME_DIR_NAME))
  return expandHomePath(configured, resolveHome())
}
