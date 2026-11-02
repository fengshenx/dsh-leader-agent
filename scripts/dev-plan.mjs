/**
 * `npm run dev` 的路径与派生计算，以及 `npm start` 复用的 profile 守卫。
 *
 * 开发实例要满足三件事：插件指向**当前工作树**（而不是主 checkout 或上一次
 * `dsh plugin add` 留下的路径）、数据（会话、项目、卡片）落在工作树内、以及
 * 不触碰用户在 `~/.dsh` 里的日常 profile。
 *
 * 做法是不复制依赖：目标 profile 的 `node_modules` 逐条符号链接到源 profile 的
 * 同名条目，只有 `dsh-leader-kit` 指向工作树。dsh 启动时读的是包解析结果，
 * 不校验 `package.json` 的 `link:` 路径与磁盘链接是否一致，所以这样一个
 * profile 能被正常加载（`npm run dev` 的隔离实例就是这么跑起来的）。
 *
 * 这里的函数只算「该建什么」与「什么情况该拒绝」，文件系统操作在 `dev.mjs`
 * 与 `start.mjs`。
 *
 * @module dsh-leader-kit/scripts/dev-plan
 */

import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 插件包名：profile 里换成工作树链接的那个。 */
export const LEADER_KIT_PACKAGE = 'dsh-leader-kit'

/** 开发实例用的 profile 名。插件的客户端 manifest 声明 `platform: web`。 */
export const PROFILE_NAME = 'web'

/** 提供 web UI 的 app bundle：`dsh web` 就是 `dsh --profile web`，界面由它挂上来。 */
export const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'

/** 从源 profile 复制过来的配置：用户在源里改过就跟着走。 */
export const COPIED_PROFILE_FILES = ['cordis.yml', 'cordis.patch.yml']

/** `dsh-credentials-local` 的存储文件名，落在各自的数据根里。 */
export const CREDENTIALS_FILE = '.credentials.yaml'

/**
 * 算出开发实例的各个目录。
 *
 * @param {object} options - 选项
 * @param {string} options.worktree - 当前工作树的绝对路径
 * @param {string} options.homeDir - 用户主目录，源 `~/.dsh` 的父目录
 * @param {object} [options.env] - 环境变量，支持 `DSH_HOME`、`DSH_HOME_SOURCE`、`DSH_PROFILE`
 * @returns {object} 目录与文件路径
 */
export function resolveDevPaths({ worktree, homeDir, env = {} }) {
  const sourceHome = env.DSH_HOME_SOURCE ?? join(homeDir, '.dsh')
  const home = env.DSH_HOME ?? join(worktree, '.dev', 'home')
  const profile = env.DSH_PROFILE === undefined || env.DSH_PROFILE === '' ? PROFILE_NAME : env.DSH_PROFILE
  const sourceProfileDir = join(sourceHome, 'profiles', profile)
  return {
    sourceHome,
    profile,
    sourceProfileDir,
    sourceNodeModules: join(sourceProfileDir, 'node_modules'),
    home,
    profileDir: join(home, 'profiles', profile),
    credentialsPath: join(home, CREDENTIALS_FILE),
    sourceCredentialsPath: join(sourceHome, CREDENTIALS_FILE),
  }
}

/**
 * 取路径的真实身份，路径不存在时退回字面量。
 *
 * @param {string} path - 路径
 * @returns {string} 规范化后的绝对路径
 */
function identityOf(path) {
  try {
    return realpathSync(path)
  } catch (error) {
    // 首次运行数据根还不存在，realpath 必然 ENOENT，这时按字面量比较即可。
    // EACCES 之类的真实错误不能当成「路径不同」放过去，否则守卫会在该拦的时候沉默。
    if (error.code !== 'ENOENT') throw error
    return resolve(path)
  }
}

/**
 * `refs:` 节头：块式（尾部可带注释）或行内映射；键名允许手写的引号写法。
 * `\r` 要显式放行：CRLF 文档按 `\n` 切行后每行都带它，而 `.` 与 `$` 都不吃回车。
 */
const REFS_HEADER = /^(?:"refs"|'refs'|refs):(?:[ \t]+(.*?))?[ \t]*\r?$/

/** 块式条目行：缩进 + 键名，兼容手写的引号写法。 */
const REF_ENTRY = /^[ \t]+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s:#][^:]*)):(?:[ \t]|\r?$)/

/** 行内映射里的单个条目。 */
const FLOW_PAIR = /^(?:"([^"\n]+)"|'([^'\n]+)'|([^\s:#][^:]*?))[ \t]*:[ \t]*([\s\S]+)$/

/** 顶层键名；顶层标量（如序列项）返回 null。引号包住的键按解析后的名字算。 */
function topLevelKeyOf(line) {
  const match = /^(?:"([^"\n]+)"|'([^'\n]+)'|([^\s:#][^:]*)):(?:[ \t]|\r?$)/.exec(line)
  return match === null ? null : (match[1] ?? match[2] ?? match[3])
}

/** 行首缩进宽度（yaml 不允许制表符作缩进，这里只比较一列性）。 */
function indentOf(line) {
  return /^[ \t]*/.exec(line)[0].length
}

/** 块式条目行的键名。 */
function refEntryKey(line) {
  const match = REF_ENTRY.exec(line)
  return match === null ? null : (match[1] ?? match[2] ?? match[3]).trim()
}

/** 按顶层逗号切分行内映射，引号内的逗号不算分隔符。 */
function splitFlowPairs(inner) {
  const parts = []
  let current = ''
  let quote = null
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (quote !== null) {
      current += char
      if (quote === '"' && char === '\\') {
        current += inner[index + 1] ?? ''
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/** 块式 `refs:` 节：条目缩进任意合法值，续行更深。 */
function parseBlockRefs(lines, header, end, trailingComment) {
  const entries = new Map()
  let indent = null
  let lastEntryEnd = header + 1
  let current = null
  for (let index = header + 1; index < end; index += 1) {
    const line = lines[index]
    if (line.trim() === '') {
      if (current !== null) {
        current.push(line)
        lastEntryEnd = index + 1
      }
      continue
    }
    const width = indentOf(line)
    if (current !== null && width > indent) {
      current.push(line)
      lastEntryEnd = index + 1
      continue
    }
    if (/^[ \t]*#/.test(line)) continue
    if (indent === null || width === indent) {
      const key = refEntryKey(line)
      if (key === null) {
        throw new Error(`凭据文档第 ${index + 1} 行：refs 节里的条目认不出（要「缩进 + 键名:」），先手工修正`)
      }
      indent = width
      current = [line]
      entries.set(key, current)
      lastEntryEnd = index + 1
      continue
    }
    throw new Error(`凭据文档第 ${index + 1} 行：refs 节的缩进比条目更浅，yaml 解析会报 BAD_INDENT，先手工修正`)
  }
  return { header, end, indent, entries, lastEntryEnd, flowLines: null, trailingComment }
}

/** 行内映射 `refs: { ... }`，含宿主删除最后一个引用后落的 `refs: {}`。 */
function parseFlowRefs(lines, header, end, trailing) {
  const match = /^\{([\s\S]*)\}([ \t]*#.*)?$/.exec(trailing)
  if (match === null) {
    throw new Error(`凭据文档第 ${header + 1} 行的 refs 是行内映射，但没找到配对的闭括号，先手工修正`)
  }
  const entries = new Map()
  const flowLines = []
  const inner = match[1].trim()
  if (inner !== '') {
    for (const part of splitFlowPairs(inner)) {
      const pair = FLOW_PAIR.exec(part)
      if (pair === null || /[[{]/.test(pair[4])) {
        throw new Error(`凭据文档第 ${header + 1} 行的 refs 行内映射里有认不出的条目，先手工改成块式`)
      }
      const key = (pair[1] ?? pair[2] ?? pair[3]).trim()
      const line = `${key}: ${pair[4].trim()}`
      entries.set(key, [line])
      flowLines.push(line)
    }
  }
  return { header, end, indent: 0, entries, lastEntryEnd: header + 1, flowLines, trailingComment: match[2] ?? '' }
}

/**
 * 解析凭据文档里的 `refs` 节。
 *
 * 认两种合法写法：块式（条目缩进任意合法值，续行更深）与行内映射（`refs: {}` /
 * `refs: { A: b }`）。宿主的写入器会产出前者、删掉最后一个引用后落成后者。
 * 认不出就抛错——猜一个拼接位置会写出第二个顶层 `refs:` 或缩进错乱，宿主解析器
 * 报 DUPLICATE_KEY / BAD_INDENT，凭据插件激活失败。
 *
 * @param {string | null | undefined} text - 凭据文档内容
 * @returns {{ lines: string[], section: object | null }} 行数组与 refs 节信息，无该节时 section 为 null
 */
function analyzeRefsSection(text) {
  const lines = String(text ?? '').split('\n')
  const headers = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/^\S/.test(line) || line.startsWith('#')) continue
    if (topLevelKeyOf(line) === 'refs') headers.push(index)
  }
  if (headers.length === 0) return { lines, section: null }
  if (headers.length > 1) {
    throw new Error(
      `凭据文档有 ${headers.length} 处顶层 refs:（第 ${headers.map((index) => index + 1).join('、')} 行），先手工合成一处`,
    )
  }
  const header = headers[0]
  let end = lines.length
  for (let index = header + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index]) && !lines[index].startsWith('#')) {
      end = index
      break
    }
  }
  const trailing = (REFS_HEADER.exec(lines[header])?.[1] ?? '').trim()
  if (trailing.startsWith('{')) return { lines, section: parseFlowRefs(lines, header, end, trailing) }
  if (trailing !== '' && !trailing.startsWith('#')) {
    throw new Error(`凭据文档第 ${header + 1} 行的 refs: 既不是块式映射也不是行内映射，先手工修正`)
  }
  return { lines, section: parseBlockRefs(lines, header, end, trailing) }
}

/** 去掉条目块尾部的空行：条目之间的空白不属于任何值。 */
function trimmedBlocks(entries) {
  const blocks = new Map()
  for (const [key, block] of entries) {
    const copy = [...block]
    while (copy.length > 0 && copy.at(-1).trim() === '') copy.pop()
    blocks.set(key, copy)
  }
  return blocks
}

/** 把条目块从一种缩进搬到另一种，续行保持相对缩进。 */
function reindentBlocks(blocks, fromIndent, toIndent) {
  const shift = toIndent - fromIndent
  return blocks.map((line) => {
    if (line.trim() === '') return ''
    const width = indentOf(line)
    return `${' '.repeat(Math.max(width + shift, 0))}${line.slice(width)}`
  })
}

/** 顶层 `version` 的值；没有该键时为 undefined。 */
function documentVersion(lines) {
  for (const line of lines) {
    if (!/^\S/.test(line) || line.startsWith('#')) continue
    const match = /^version:[ \t]*(\S*)/.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}

/** 写回前自检：结果里只能有一处顶层 refs，且条目集合正好是合并期望的那一组。 */
function verifyMerged(text, existing, keys) {
  try {
    const section = analyzeRefsSection(text).section
    const expected = new Set([...existing, ...keys])
    const actual = new Set(section === null ? [] : section.entries.keys())
    if (section === null || actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) {
      throw new Error('refs 节的条目与合并结果不一致')
    }
  } catch (error) {
    throw new Error(`合并后的凭据文档自检失败（${error.message}），未写入；请手工检查该文件`)
  }
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * 从凭据文档里取出 `refs` 节的条目块。
 *
 * 值原样保留——多行值与引号都不重新转义，避免把密钥改坏。
 *
 * @param {string | null | undefined} text - 凭据文档内容
 * @returns {Map<string, string[]>} 键名到该条目原始行（含首行）的映射
 */
export function credentialRefBlocks(text) {
  const section = analyzeRefsSection(text).section
  return section === null ? new Map() : trimmedBlocks(section.entries)
}

/**
 * 把源凭据的 `refs` 条目并入开发实例的凭据文档。
 *
 * 只搬 `refs`：`records` 里的账号授权带刷新令牌，两个实例各持一份会互相踢掉登录。
 * 目标里已有的条目不动——那是用户在这个实例里保存过的值，应当优先。写回时替换
 * 目标已有的 `refs` 节（块式或行内），绝不追加第二个 `refs:`。
 *
 * @param {object} options - 选项
 * @param {string} options.sourceText - 源 HOME 的凭据文档
 * @param {string | null | undefined} options.targetText - 开发实例的凭据文档，文件不存在为 null
 * @returns {{ text: string | null, keys: string[], notice: string | null }} 合并后的文档（无需变更时为 null）、
 *   新增的键名，以及本次不合并时的原因
 */
export function mergeCredentialRefs({ sourceText, targetText }) {
  const source = analyzeRefsSection(sourceText).section
  if (source === null || source.entries.size === 0) return { text: null, keys: [], notice: null }
  const sourceBlocks = trimmedBlocks(source.entries)

  if (targetText === null || targetText === undefined || targetText.trim() === '') {
    const blocks = [...sourceBlocks.values()].flatMap((block) => reindentBlocks(block, source.indent, 2))
    const keys = [...sourceBlocks.keys()]
    const text = `version: 1\nrefs:\n${blocks.join('\n')}\n`
    return { text: verifyMerged(text, [], keys), keys, notice: null }
  }

  const lines = String(targetText).split('\n')
  const version = documentVersion(lines)
  // 守卫在所有写入路径之前：不是 version 1 的文档写入只会让宿主更没法解析。没有
  // version 的非空文档是 pre-release 扁平布局，宿主启动时会自行迁移；先追加
  // `refs:` 会让它既不是扁平的、也没有 version，插件激活反而失败。
  if (version === undefined) {
    return {
      text: null,
      keys: [],
      notice: '开发实例的凭据文档不是 version 1 布局（pre-release 扁平布局），宿主启动时会自行迁移；本次不合并',
    }
  }
  if (version !== '1') {
    return { text: null, keys: [], notice: `开发实例的凭据文档声明 version ${version}，本脚本只合并 version 1；本次不合并` }
  }
  const { section } = analyzeRefsSection(targetText)
  if (section === null) {
    const keys = [...sourceBlocks.keys()]
    const blocks = keys.flatMap((key) => reindentBlocks(sourceBlocks.get(key), source.indent, 2))
    const body = [...lines]
    while (body.length > 0 && body.at(-1).trim() === '') body.pop()
    const text = `${body.join('\n')}\nrefs:\n${blocks.join('\n')}\n`
    return { text: verifyMerged(text, [], keys), keys, notice: null }
  }

  const existing = new Set(section.entries.keys())
  const keys = [...sourceBlocks.keys()].filter((key) => !existing.has(key))
  if (keys.length === 0) return { text: null, keys: [], notice: null }
  // 行内映射要展开成块式，统一两格；空节与块式节沿用节内已有缩进。
  const targetIndent = section.flowLines === null && section.indent !== null ? section.indent : 2
  const blocks = keys.flatMap((key) => reindentBlocks(sourceBlocks.get(key), source.indent, targetIndent))
  const merged = [...lines]
  if (section.flowLines !== null) {
    merged.splice(
      section.header,
      1,
      `refs:${section.trailingComment}`,
      ...section.flowLines.map((line) => `  ${line}`),
      ...blocks,
    )
  } else {
    merged.splice(section.lastEntryEnd, 0, ...blocks)
  }
  const text = verifyMerged(merged.join('\n'), existing, keys)
  return { text, keys, notice: null }
}

/**
 * 挡住「数据根就是源 HOME」这个误用。
 *
 * 两边相同时派生逻辑会把源 profile 本身改写：`package.json` 里的插件依赖被换成
 * 工作树链接，`node_modules` 里每个真实依赖目录被删掉、换成指向自己的死链——
 * 跑一次 `npm run dev` 就把日常 dsh 装好的 profile 毁了，只能重装。而
 * `DSH_HOME=~/.dsh` 恰好是个很自然的「想复用日常数据」的写法。
 *
 * 比较用真实路径：符号链接或 `..` 绕一圈指到同一处也算相同。
 *
 * @param {object} options - 选项
 * @param {string} options.home - 开发实例的数据根
 * @param {string} options.sourceHome - 源 HOME
 * @returns {void} 不相同时无返回
 */
export function assertSeparateHome({ home, sourceHome }) {
  if (identityOf(home) === identityOf(sourceHome)) {
    throw new Error(
      `数据根与源 HOME 是同一个目录（${home}），继续会覆写你的日常 profile：`
      + 'package.json 里的插件依赖会被换成工作树链接，node_modules 里的真实依赖会被换成自指死链。'
      + '换一个 DSH_HOME，或去掉 DSH_HOME 让数据根落到工作树内的 .dev/home。',
    )
  }
}

/**
 * 挡住「profile 没有 web UI」这个误用。
 *
 * `DSH_PROFILE` 接受任意名字，但只有落在宿主 `PROFILE_TEMPLATES` 里的名字才带
 * app bundle。实测一个只含 `@deepseek-ai/dsh-base` 的 profile 跑 `dsh web`：
 * 不监听端口、不打印 URL、也不报错——进程静默地什么都不做，而 `npm run dev`
 * 看起来是成功的。判据直接看 profile 的 bundles 里有没有 web app bundle，
 * 不抄宿主的模板表（那份表会随版本变）。
 *
 * 修复建议由调用方给：`dev` 能换 `DSH_PROFILE`，`start` 的 profile 名是固定的
 * （`profiles/web`），照前者的建议做无效。
 *
 * @param {object} options - 选项
 * @param {string} options.profileDir - profile 目录，只用于报错定位
 * @param {string[] | undefined} options.bundles - 该 profile 的 `dsh.profile.bundles`
 * @param {string} options.hint - 该调用方能照做的修复建议，必填
 * @returns {void} 有 web app bundle 时无返回
 */
export function assertWebBundle({ profileDir, bundles, hint }) {
  if (typeof hint !== 'string' || hint === '') {
    throw new Error('assertWebBundle 需要 hint：每个调用方各给自己能执行的修复建议')
  }
  if (Array.isArray(bundles) && bundles.includes(WEB_APP_BUNDLE)) return
  throw new Error(
    `profile 的 bundles 里没有 ${WEB_APP_BUNDLE}（${profileDir}），dsh web 起不来：`
    + `实测不监听端口、不打印 URL、也不报错。${hint}`,
  )
}

/**
 * `dev` 的修复建议：源 profile 名可由 `DSH_PROFILE` 换掉。
 *
 * @returns {string} 修复建议
 */
export function devWebBundleHint() {
  return `用 DSH_PROFILE 指向一个 web profile，或把 ${WEB_APP_BUNDLE} 加进该 profile 的 dsh.profile.bundles。`
}

/**
 * `start` 的修复建议：它的 profile 名固定为 `profiles/web`，换 profile 名的建议对它无效。
 *
 * @param {object} options - 选项
 * @param {string} options.profileDir - 日常 profile 目录
 * @param {string} options.dshCommand - dsh 可执行文件，用于给出可复制的命令
 * @param {string} options.worktree - 当前仓库路径
 * @returns {string} 修复建议
 */
export function startWebBundleHint({ profileDir, dshCommand, worktree }) {
  return `把 ${WEB_APP_BUNDLE} 加进该 profile 的 dsh.profile.bundles，`
    + `或删掉 ${profileDir} 让 dsh 按 ${PROFILE_NAME} 模板重建后再装本插件: `
    + `${dshCommand} plugin --profile ${PROFILE_NAME} add ${worktree}`
}

/**
 * `package.json` 解析失败时的错误文案。
 *
 * `dsh plugin` 在该目录里跑 pnpm，pnpm 也读这份文件，文件坏了它同样以 JSON 解析
 * 错误退出——所以「重装一次」不是可执行的修法，必须先修好或删掉文件。原始报错
 * 原样保留，它指到出错的字符位置。
 *
 * @param {object} options - 选项
 * @param {string} options.packagePath - 损坏的 `package.json` 路径
 * @param {string} options.parseMessage - `JSON.parse` 的原始报错
 * @param {string} options.dshCommand - dsh 可执行文件，用于给出可复制的命令
 * @param {string} options.worktree - 当前仓库路径
 * @returns {string} 错误文案
 */
export function corruptProfilePackageMessage({ packagePath, parseMessage, dshCommand, worktree }) {
  return `${packagePath} 不是合法 JSON（${parseMessage}）：dsh plugin 装东西时也读这份文件，`
    + '损坏时它会一起失败。先手工修好它，'
    + `或删掉 ${dirname(packagePath)} 让 dsh 按 ${PROFILE_NAME} 模板重建（删前确认里面没有别的插件），`
    + `再重装: ${dshCommand} plugin --profile ${PROFILE_NAME} add ${worktree}`
}

/**
 * 挡住「日常 profile 没装本插件」这个误用。
 *
 * `npm start` 起的是日常 `~/.dsh` 那套，插件加载与否只看该 profile 的 bundles。
 * 没装时 dsh 照常起来，只是右栏没有看板、协调者工具也不存在——看起来像插件坏了。
 *
 * @param {object} options - 选项
 * @param {string} options.profileDir - 日常 profile 目录，只用于报错定位
 * @param {string[] | undefined} options.bundles - 该 profile 的 `dsh.profile.bundles`
 * @param {string} options.worktree - 当前仓库路径，用于给出可复制的安装命令
 * @returns {void} 已装本插件时无返回
 */
export function assertLeaderKitBundle({ profileDir, bundles, worktree }) {
  if (Array.isArray(bundles) && bundles.includes(LEADER_KIT_PACKAGE)) return
  throw new Error(
    `日常 profile 的 bundles 里没有 ${LEADER_KIT_PACKAGE}（${profileDir}），这个实例不会加载本插件。`
    + `先装一次：dsh plugin --profile ${PROFILE_NAME} add ${worktree}`,
  )
}

/**
 * 从源 profile 的 `package.json` 派生开发实例的版本。
 *
 * 依赖与 bundle 列表都照源抄——开发实例要复现日常环境的组合，否则「本地跑得
 * 起来、装进 profile 就坏」这类问题测不出来。只有两处不同：`dsh-leader-kit`
 * 的依赖换成工作树链接，bundle 列表保证含它（源里没装过本插件时也能起）。
 *
 * @param {object} sourcePackage - 源 profile 的 `package.json` 解析结果
 * @param {string} worktree - 当前工作树的绝对路径
 * @returns {object} 派生后的 `package.json` 对象
 */
export function deriveProfilePackage(sourcePackage, worktree) {
  const bundles = [...(sourcePackage?.dsh?.profile?.bundles ?? [])]
  if (!bundles.includes(LEADER_KIT_PACKAGE)) bundles.push(LEADER_KIT_PACKAGE)
  return {
    ...sourcePackage,
    dependencies: {
      ...(sourcePackage?.dependencies ?? {}),
      [LEADER_KIT_PACKAGE]: `link:${worktree}`,
    },
    dsh: {
      ...(sourcePackage?.dsh ?? {}),
      profile: {
        ...(sourcePackage?.dsh?.profile ?? {}),
        bundles,
      },
    },
  }
}

/**
 * 算出 `node_modules` 该怎么摆。
 *
 * 源 profile 的每个条目都链过去（依赖由它在源里那一份承担，升级时开发实例自动
 * 跟随），只有插件本体指工作树。目标里多出来的条目要删掉——源里已经移除的插件
 * 留在开发实例里会让「卸掉它之后还能不能起」测不出来。
 *
 * @param {object} options - 选项
 * @param {string[]} options.sourceEntries - 源 `node_modules` 的条目名
 * @param {string[]} options.existingEntries - 目标 `node_modules` 已有的条目名
 * @param {string} options.sourceNodeModules - 源 `node_modules` 的绝对路径
 * @param {string} options.worktree - 当前工作树的绝对路径
 * @returns {{ links: { name: string, target: string }[], removals: string[] }} 链接与清理计划
 */
export function planNodeModules({ sourceEntries, existingEntries, sourceNodeModules, worktree }) {
  const links = sourceEntries
    .filter((name) => name !== LEADER_KIT_PACKAGE)
    .map((name) => ({ name, target: join(sourceNodeModules, name) }))
  links.push({ name: LEADER_KIT_PACKAGE, target: worktree })
  const removals = existingEntries
    .filter((name) => !sourceEntries.includes(name) && name !== LEADER_KIT_PACKAGE)
  return { links, removals }
}

/** `dsh web` 的就绪行；地址本身由 `connection.authenticatedUrl` 生成，带 `?token=`。 */
const WEB_URL_LINE = /^dsh web: (\S+)$/

/**
 * 从 `dsh web` 的启动日志里取带 token 的访问地址。
 *
 * 端口用 `--port 0` 时由系统分配，token 每次启动都变——两者都只能从这一行读，
 * 不能凭上一次运行的值猜（上一轮的值已经失效，会把人带到错误的结论上）。
 *
 * @param {string} line - 启动日志的一行
 * @returns {{ url: string, origin: string, port: number, token: string } | null} 不是就绪行时为 null
 */
export function parseWebUrlLine(line) {
  const match = WEB_URL_LINE.exec(String(line).trim())
  if (match === null) return null
  let url
  try {
    url = new URL(match[1])
  } catch (error) {
    throw new Error(`dsh web 打印的地址不是合法 URL：${match[1]}（${error.message}）`)
  }
  const token = url.searchParams.get('token')
  if (token === null || token === '') {
    throw new Error(`dsh web 打印的地址没有 token：${match[1]}——无 token 打不开需要鉴权的页面`)
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`dsh web 打印的地址没有端口：${match[1]}——端口 0 时宿主一定会给真实端口`)
  }
  return { url: url.href, origin: url.origin, port, token }
}

/** cordis 配置里的显式端点键；`baseURL` 是 llm-deepseek 的写法，`baseUrl` 是社区插件的写法。 */
const EXPLICIT_ENDPOINT = /\bbase_?[uU]rl\s*:/i

/**
 * 找出把模型端点钉死在本地的 profile 配置文件。
 *
 * e2e 靠 `DEEPSEEK_BASE_URL` 把模型指向本地 mock，而显式配置的优先级比环境变量
 * 高——命中时 mock 会被静默绕开，场景于是拿真实模型或真实网络跑，断言看起来
 * 绿了却什么都没证明。这种情况必须报错，不能靠运气。
 *
 * @param {{ path: string, text: string | null }[]} files - profile 配置文件与其内容（不存在为 null）
 * @returns {string[]} 含显式端点的文件路径
 */
export function explicitEndpointFiles(files) {
  return files
    .filter(({ text }) => typeof text === 'string' && EXPLICIT_ENDPOINT.test(text))
    .map(({ path }) => path)
}
