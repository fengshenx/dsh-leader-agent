/**
 * `npm run dev` 的路径与派生计算。
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
 * 这里的函数只算「该建什么」，文件系统操作在 `dev.mjs`。
 *
 * @module dsh-leader-kit/scripts/dev-plan
 */

import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 插件包名：profile 里换成工作树链接的那个。 */
export const LEADER_KIT_PACKAGE = 'dsh-leader-kit'

/** 开发实例用的 profile 名。插件的客户端 manifest 声明 `platform: web`。 */
export const PROFILE_NAME = 'web'

/** 提供 web UI 的 app bundle：`dsh web` 就是 `dsh --profile web`，界面由它挂上来。 */
export const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'

/** 从源 profile 复制过来的配置：用户在源里改过就跟着走。 */
export const COPIED_PROFILE_FILES = ['cordis.yml', 'cordis.patch.yml']

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
 * 挡住「源 profile 没有 web UI」这个误用。
 *
 * `DSH_PROFILE` 接受任意名字，但只有落在宿主 `PROFILE_TEMPLATES` 里的名字才带
 * app bundle。实测一个只含 `@deepseek-ai/dsh-base` 的 profile 跑 `dsh web`：
 * 不监听端口、不打印 URL、也不报错——进程静默地什么都不做，而 `npm run dev`
 * 看起来是成功的。判据直接看源 profile 的 bundles 里有没有 web app bundle，
 * 不抄宿主的模板表（那份表会随版本变）。
 *
 * @param {object} options - 选项
 * @param {string} options.profileDir - 源 profile 目录，只用于报错定位
 * @param {string[] | undefined} options.bundles - 源 profile 的 `dsh.profile.bundles`
 * @returns {void} 有 web app bundle 时无返回
 */
export function assertWebBundle({ profileDir, bundles }) {
  if (Array.isArray(bundles) && bundles.includes(WEB_APP_BUNDLE)) return
  throw new Error(
    `源 profile 的 bundles 里没有 ${WEB_APP_BUNDLE}（${profileDir}），dsh web 起不来：`
    + '实测不监听端口、不打印 URL、也不报错。'
    + `用 DSH_PROFILE 指向一个 web profile，或把 ${WEB_APP_BUNDLE} 加进该 profile 的 dsh.profile.bundles。`,
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
