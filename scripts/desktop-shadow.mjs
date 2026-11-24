/**
 * 影子数据根：让桌面版跑本仓代码，同时不碰日常 `~/.dsh` 的 desktop profile。
 *
 * 宿主把 profile 写死在 `$DSH_HOME/profiles/desktop`，没有 profile 开关。这里不换
 * 名、不改日常 profile，而是给应用一个影子 `DSH_HOME`：影子里的 `profiles/desktop`
 * 是从日常 profile 派生的开发 profile，其余顶层项（sessions、storages、cards…）
 * 链回日常根。线上 profile 一个字节不动，直接启动仍用线上版；应用被 kill、崩溃或
 * 断电都没有需要还原的状态。
 *
 * @module dsh-leader-agent/scripts/desktop-shadow
 */

import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { prepareProfileDir } from './dev-instance.mjs'

/** 不共享、也不复制到影子根的顶层项：`profiles` 由本模块造，凭据与 Finder 垃圾另有处理。 */
const SKIP_TOP_LEVEL = new Set(['profiles', '.DS_Store', '.credentials.yaml'])

/** 日常 profile 的 patch 里已有 `credentials` 行时，用它判断凭据是否已经指向日常文件。 */
const CREDENTIALS_ROW = /^[ \t]*-[ \t]+id:[ \t]*['"]?credentials['"]?[ \t]*$/m

/**
 * 把日常根的顶层项暴露到影子根。
 *
 * 目录用符号链接（Windows 用 junction，不需要管理员），真正的会话与卡片写回日常根。
 * 文件用复制：凭据文件由 `pinSharedCredentials` 指回日常路径，不需要影子副本；其余
 * 都是只读小文件，复制比文件符号链接少一层平台权限要求。复制过的项写进清单，
 * 下次启动时据此区分「我们造的副本」与「宿主新写的数据域」。
 *
 * @param {object} options - 选项
 * @param {string} options.sourceHome - 日常数据根
 * @param {string} options.shadowHome - 影子数据根
 * @returns {string[]} 本次创建的顶层项名字
 */
function exposeSourceEntries({ sourceHome, shadowHome }) {
  const created = []
  for (const name of readdirSync(sourceHome)) {
    if (SKIP_TOP_LEVEL.has(name)) continue
    const from = join(sourceHome, name)
    const to = join(shadowHome, name)
    if (statSync(from).isDirectory()) {
      symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir')
    } else {
      copyFileSync(from, to)
    }
    created.push(name)
  }
  return created
}

/**
 * 读影子根清单；没有或版本/来源不符时返回 null。
 *
 * 清单记录「本脚本建了哪些顶层项」。宿主将来新增的数据域不会在清单里，启动时会被
 * 当成 leftover 搬回日常根，避免数据悄悄落在影子里。
 *
 * @param {string} manifestPath - 清单路径
 * @param {string} sourceHome - 本次使用的日常根
 * @returns {{ entries: string[], sourceHome: string } | null} 清单内容
 */
function readShadowManifest(manifestPath, sourceHome) {
  if (!existsSync(manifestPath)) return null
  try {
    const value = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (value?.version !== 1 || !Array.isArray(value.entries) || typeof value.sourceHome !== 'string') return null
    if (value.sourceHome !== sourceHome) return null
    return { entries: value.entries.filter((entry) => typeof entry === 'string'), sourceHome }
  } catch {
    return null
  }
}

/**
 * 移动一个顶层项；跨文件系统时退回复制。
 *
 * @param {string} from - 源路径
 * @param {string} to - 目标路径
 * @returns {void} 无返回
 */
function moveEntry(from, to) {
  try {
    renameSync(from, to)
    return
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
  }
  if (statSync(from).isDirectory()) {
    cpSync(from, to, { recursive: true, force: false, errorOnExist: true })
    rmSync(from, { recursive: true, force: true })
    return
  }
  copyFileSync(from, to)
  rmSync(from, { force: true })
}

/**
 * 把上一次会话里宿主新写的顶层项搬回日常根。
 *
 * 正常会话只会在链回日常根的目录里写数据；宿主将来新增一个顶层数据域时，它会落在
 * 影子里。启动时（以及 `--remove` 删除影子前）把这些不在清单里的实体搬回日常根，
 * 已经在日常根有同名实体的挪到旁边并告警——不删数据，也不覆盖用户已有的目录。
 *
 * @param {object} options - 选项
 * @param {string} options.sourceHome - 日常数据根
 * @param {string} options.shadowHome - 影子数据根
 * @param {string} options.manifestPath - 影子清单
 * @returns {{ migrated: string[], conflicts: string[], foreign: boolean }} 搬回与冲突的名字
 */
function migrateLeftovers({ sourceHome, shadowHome, manifestPath }) {
  if (!existsSync(shadowHome)) return { migrated: [], conflicts: [], foreign: false }
  const manifest = readShadowManifest(manifestPath, sourceHome)
  if (manifest === null) {
    // 没有清单（旧版本、崩溃在建清单之前，或另一个 DSH_HOME 建的影子）时不动它
    // 的内容。只有实体项才算「来历不明」；本脚本建的目录链接可以安全重建。
    const entries = readdirSync(shadowHome).filter((name) => {
      if (name === 'profiles' || name === '.desktop-shadow.json') return false
      return !lstatSync(join(shadowHome, name)).isSymbolicLink()
    })
    return { migrated: [], conflicts: [], foreign: entries.length > 0 }
  }
  const known = new Set(manifest.entries)
  const migrated = []
  const conflicts = []
  for (const name of readdirSync(shadowHome)) {
    if (name === 'profiles' || name === '.desktop-shadow.json' || known.has(name)) continue
    const entry = join(shadowHome, name)
    const target = join(sourceHome, name)
    if (!existsSync(target)) {
      moveEntry(entry, target)
      migrated.push(name)
      continue
    }
    const aside = join(dirname(shadowHome), `desktop-home-leftover-${Date.now()}-${name}`)
    renameSync(entry, aside)
    conflicts.push(`${name} -> ${aside}`)
  }
  return { migrated, conflicts, foreign: false }
}

/**
 * 读 profile patch 里 `credentials` 行的文本块。
 *
 * 只做「找块」这一件事：调用方只关心块里有没有 `path` / `dshHome` / `disabled`。
 *
 * @param {string} text - patch 文本
 * @returns {string | null} 块的各行（含首行），没有时为 null
 */
function credentialsRowBlock(text) {
  const match = CREDENTIALS_ROW.exec(text)
  if (match === null) return null
  const lines = text.slice(match.index).split('\n')
  const block = [lines[0]]
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('- ')) break
    block.push(lines[index])
  }
  return block.join('\n')
}

/**
 * 把开发 profile 的凭据文件指回日常根。
 *
 * `credentials-local` 默认写 `$DSH_HOME/.credentials.yaml`；影子根的 `DSH_HOME` 不是
 * 日常根，不覆盖就会分叉出一份（浏览器会话签名密钥、API key 各写各的）。patch 里
 * 的 `credentials` 行已经有 `path` / `dshHome` 时说明日常实例本来就没用默认位置，
 * 保持原样即可；有该行却两者都没有时拒绝启动，让人先补一个明确的路径。
 *
 * @param {object} options - 选项
 * @param {string} options.sourceHome - 日常数据根
 * @param {string} options.shadowProfileDir - 影子里的开发 profile
 * @returns {{ mode: 'appended' | 'custom', path: string | null }} 结果
 */
function pinSharedCredentials({ sourceHome, shadowProfileDir }) {
  const patchPath = join(shadowProfileDir, 'cordis.patch.yml')
  const text = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const block = credentialsRowBlock(text)
  if (block !== null) {
    if (/\b(?:path|dshHome|disabled)\s*:/.test(block)) return { mode: 'custom', path: null }
    throw new Error(
      `${patchPath} 里的 credentials 行既没有 path 也没有 dshHome，开发根会另写一份凭据。`
      + '\n给它加 `path: ' + join(sourceHome, '.credentials.yaml') + '`，或删掉这一行后重跑。',
    )
  }
  const credentialsPath = join(sourceHome, '.credentials.yaml')
  const row = `- id: credentials\n  config:\n    path: ${JSON.stringify(credentialsPath)}\n`
  writeFileSync(patchPath, text.trimEnd() === '' ? row : `${text.trimEnd()}\n\n${row}`, 'utf8')
  return { mode: 'appended', path: credentialsPath }
}

/**
 * 重建影子根并派生开发 profile。
 *
 * 顺序：先迁移 leftover（数据不能丢），再删旧影子、建顶层链接、派生 profile、把
 * 凭据指回日常。任何一步失败都不会碰日常 profile；影子本身下次重建。
 *
 * @param {object} options - 选项
 * @param {string} options.sourceHome - 日常数据根
 * @param {string} options.worktree - 当前工作树
 * @param {object} options.shadowPaths - `desktopShadowPaths` 的结果
 * @param {object} options.sourcePackage - 日常 profile 的 `package.json` 解析结果
 * @returns {{ credentials: { mode: string, path: string | null }, migrated: string[], conflicts: string[], foreign: boolean, foreignPath: string | null }} 结果
 */
export function syncShadowHome({ sourceHome, worktree, shadowPaths, sourcePackage }) {
  const leftovers = migrateLeftovers({ sourceHome, shadowHome: shadowPaths.home, manifestPath: shadowPaths.manifestPath })
  let foreignPath = null
  if (leftovers.foreign) {
    // 没有清单又有实体项：整份挪到旁边保留，不删。下次仍能人工找回。
    foreignPath = join(dirname(shadowPaths.home), `desktop-home-foreign-${Date.now()}`)
    renameSync(shadowPaths.home, foreignPath)
  }
  rmSync(shadowPaths.home, { recursive: true, force: true })
  mkdirSync(shadowPaths.home, { recursive: true })

  const entries = exposeSourceEntries({ sourceHome, shadowHome: shadowPaths.home })
  writeFileSync(
    shadowPaths.manifestPath,
    `${JSON.stringify({ version: 1, sourceHome, entries }, null, 2)}\n`,
    'utf8',
  )

  mkdirSync(shadowPaths.profileDir, { recursive: true })
  prepareProfileDir({
    worktree,
    paths: {
      profileDir: shadowPaths.profileDir,
      sourceProfileDir: shadowPaths.sourceProfileDir,
      sourceNodeModules: join(shadowPaths.sourceProfileDir, 'node_modules'),
    },
    sourcePackage,
  })
  const credentials = pinSharedCredentials({ sourceHome, shadowProfileDir: shadowPaths.profileDir })
  return { credentials, ...leftovers, foreignPath }
}

/**
 * 删除影子根；删除前先把宿主新写的顶层项搬回日常根。
 *
 * 没有清单又存在实体项时拒绝删除：分不清是旧版本影子还是别人放的目录，删了可能
 * 丢数据。此时打印路径，让人自己看一眼。
 *
 * @param {object} options - 选项
 * @param {string} options.sourceHome - 日常数据根
 * @param {object} options.shadowPaths - `desktopShadowPaths` 的结果
 * @returns {{ removed: boolean, migrated: string[], conflicts: string[], refused: string[] | null }} 结果
 */
export function removeShadowHome({ sourceHome, shadowPaths }) {
  if (!existsSync(shadowPaths.home)) {
    return { removed: false, migrated: [], conflicts: [], refused: null }
  }
  const leftovers = migrateLeftovers({ sourceHome, shadowHome: shadowPaths.home, manifestPath: shadowPaths.manifestPath })
  if (leftovers.foreign) {
    return {
      removed: false,
      migrated: leftovers.migrated,
      conflicts: leftovers.conflicts,
      refused: readdirSync(shadowPaths.home).filter((name) => {
        if (name === 'profiles' || name === '.desktop-shadow.json') return false
        return !lstatSync(join(shadowPaths.home, name)).isSymbolicLink()
      }),
    }
  }
  rmSync(shadowPaths.home, { recursive: true, force: true })
  const devDir = dirname(shadowPaths.home)
  if (readdirSync(devDir).length === 0) rmSync(devDir, { recursive: true, force: true })
  return { removed: true, migrated: leftovers.migrated, conflicts: leftovers.conflicts, refused: null }
}
