/**
 * `npm run desktop` 的路径解析与 profile 改写计算。
 *
 * 桌面版（DeepSeek Harness Desktop）是 Electron 壳 + 完整 Web 应用，profile 固定
 * 在 `$DSH_HOME/profiles/desktop`，与 CLI 的 `profiles/web` 各管各的包与激活状态。
 * 所以「在桌面端用」= 把本插件挂进 desktop profile；这里只算要改成什么样、什么
 * 情况该拒绝，文件系统操作在 `desktop.mjs`。
 *
 * @module dsh-leader-kit/scripts/desktop-plan
 */

import { join } from 'node:path'
import { LEADER_KIT_PACKAGE } from './dev-plan.mjs'

/** 桌面应用自己拥有的 profile 名；`apps/desktop/src/paths.ts` 里写死的那个。 */
export const DESKTOP_PROFILE = 'desktop'

/** 桌面应用在 macOS 上的默认名字，`open -a` 用；`DSH_DESKTOP_APP` 可换。 */
export const DESKTOP_APP_NAME = 'DeepSeek Harness'

/**
 * 算出桌面 profile 的各个路径。
 *
 * @param {object} options - 选项
 * @param {string} options.homeDir - 用户主目录，默认数据根的父目录
 * @param {object} [options.env] - 环境变量，支持 `DSH_HOME`（空串按未设处理）
 * @returns {object} 数据根与 profile 内的文件路径
 */
export function resolveDesktopPaths({ homeDir, env = {} }) {
  const configured = env.DSH_HOME === undefined || env.DSH_HOME.trim() === '' ? null : env.DSH_HOME
  const home = configured ?? join(homeDir, '.dsh')
  const profileDir = join(home, 'profiles', DESKTOP_PROFILE)
  const nodeModulesDir = join(profileDir, 'node_modules')
  return {
    home,
    profileDir,
    packagePath: join(profileDir, 'package.json'),
    nodeModulesDir,
    linkPath: join(nodeModulesDir, LEADER_KIT_PACKAGE),
  }
}

/**
 * 本插件在这个工作树下的 `link:` 说明符。
 *
 * @param {string} worktree - 工作树绝对路径
 * @returns {string} `link:` 说明符
 */
export function desktopLinkSpec(worktree) {
  return `link:${worktree}`
}

/**
 * 读出 profile 里已经声明的本插件来源，没装时为 null。
 *
 * @param {object} manifest - profile 的 `package.json` 解析结果
 * @returns {string | null} 依赖说明符
 */
export function installedSpecOf(manifest) {
  return manifest?.dependencies?.[LEADER_KIT_PACKAGE] ?? null
}

/**
 * 算出「把本插件挂进 desktop profile」后的 manifest。
 *
 * 幂等：已经是本工作树的链接时 `changed` 为 false。已经装了一份别的来源（App 内
 * 插件管理装的版本、别的工作树）时直接拒绝——覆盖用户日常 profile 里的安装要由人
 * 决定，脚本不替它选。
 *
 * @param {object} options - 选项
 * @param {object} options.manifest - 当前 parse 出来的 `package.json`
 * @param {string} options.worktree - 工作树绝对路径
 * @returns {{ manifest: object, changed: boolean }} 新 manifest 与是否有变化
 * @throws 已装来源不同、或 profile 的 `dsh.profile` 结构不成立时
 */
export function planDesktopEnable({ manifest, worktree }) {
  const spec = desktopLinkSpec(worktree)
  const installed = installedSpecOf(manifest)
  if (installed !== null && installed !== spec) {
    throw new Error(
      `desktop profile 里已经装了一份 ${LEADER_KIT_PACKAGE}（${installed}），不是当前目录 ${worktree}。`
      + '\n它可能是桌面 App 的插件管理装的，也可能是另一个工作树挂上去的。'
      + `\n先卸掉再重跑：npm run desktop -- --remove，或在 DeepSeek Harness 的插件管理里卸载。`,
    )
  }
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? [...manifest.dsh.profile.bundles] : null
  if (bundles === null) {
    throw new Error(
      'desktop profile 的 package.json 里没有 dsh.profile.bundles 列表：'
      + '这不是一个完整的桌面 profile。先打开一次 DeepSeek Harness 让它初始化，或删掉该 profile 让应用重建。',
    )
  }
  if (!bundles.includes(LEADER_KIT_PACKAGE)) bundles.push(LEADER_KIT_PACKAGE)
  const next = {
    ...manifest,
    dependencies: { ...(manifest.dependencies ?? {}), [LEADER_KIT_PACKAGE]: spec },
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles } },
  }
  return { manifest: next, changed: JSON.stringify(next) !== JSON.stringify(manifest) }
}

/**
 * 算出「把本插件从 desktop profile 摘掉」后的 manifest。
 *
 * 只摘本插件：依赖条目与 `bundles` 里的同名项，其余条目与顺序原样保留。
 *
 * @param {object} options - 选项
 * @param {object} options.manifest - 当前 parse 出来的 `package.json`
 * @returns {{ manifest: object, changed: boolean }} 新 manifest 与是否有变化
 */
export function planDesktopDisable({ manifest }) {
  const dependencies = { ...(manifest?.dependencies ?? {}) }
  delete dependencies[LEADER_KIT_PACKAGE]
  const current = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const bundles = current.filter((name) => name !== LEADER_KIT_PACKAGE)
  const next = {
    ...manifest,
    dependencies,
    dsh: { ...manifest?.dsh, profile: { ...manifest?.dsh?.profile, bundles } },
  }
  return {
    manifest: next,
    changed: bundles.length !== current.length || LEADER_KIT_PACKAGE in (manifest?.dependencies ?? {}),
  }
}
