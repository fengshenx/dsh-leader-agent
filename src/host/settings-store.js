/**
 * 插件设置的宿主侧落盘存储。
 *
 * 自动续行上限决定机制侧在无人值守时最多唤醒 leader 多少次，必须让 Node 侧的
 * 派工器在投递那一刻读到；看板模式决定列表还是线路图，也要跟着实例走而不是
 * 跟着某个浏览器走。两者都落到 dsh home 下的自有目录，与通知队列、worker
 * 登记表同构：原子写 + 串行读改写。
 *
 * 设置是**实例级**的：同一个 dsh 数据根下的所有项目共用一份。它不写项目记录、
 * 卡片或会话事件——那些是业务事实，改显示偏好或护栏不该让它们产生 revision。
 *
 * 读取在构造时同步完成：派工器要在第一轮投递前就拿到配置，异步加载会让启动窗口
 * 里的回报按默认值判断。文件很小，同步读的代价可以忽略；写入仍走异步原子替换。
 *
 * @module dsh-leader-agent/host/settings-store
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUTO_RESUME_LIMIT_DEFAULT,
  AUTO_RESUME_LIMIT_MAX,
  AUTO_RESUME_LIMIT_MIN,
  BOARD_MODE_DEFAULT,
  parseAutoResumeLimit,
  parseBoardMode,
} from '../shared/settings.js'

const SETTINGS_VERSION = 2

/**
 * 默认设置。
 * @type {Readonly<{ autoResumeLimit: number, boardMode: string }>}
 */
const DEFAULT_SETTINGS = Object.freeze({
  autoResumeLimit: AUTO_RESUME_LIMIT_DEFAULT,
  boardMode: BOARD_MODE_DEFAULT,
})

/**
 * 从原始设置对象里取自动续行上限；非法或缺失时退回默认值。
 *
 * 读路径不抛错：一个手改坏了的配置文件不该让整个插件在启动时失败。调用方拿到的
 * 永远是可用值，坏值由日志说明；下一次通过设置页保存会把它写成合法值。
 *
 * @param {unknown} raw - 解析后的 JSON
 * @param {(message: string) => void} logger - 日志输出
 * @returns {number} 合法上限
 */
function readAutoResumeLimit(raw, logger) {
  const value = parseAutoResumeLimit(raw?.autoResumeLimit)
  if (value !== undefined) return value
  logger(`dsh-leader-agent: settings.json 的 autoResumeLimit 非法，使用默认值 ${AUTO_RESUME_LIMIT_DEFAULT}`)
  return AUTO_RESUME_LIMIT_DEFAULT
}

/**
 * 从原始设置对象里取看板模式。
 *
 * 旧版设置文件只有 autoResumeLimit，没有 boardMode；缺省按工作模式读，不写日志，
 * 避免每次启动都报一条「配置坏了」。字段存在但值非法才留日志并退回默认。
 *
 * @param {unknown} raw - 解析后的 JSON
 * @param {(message: string) => void} logger - 日志输出
 * @returns {string} 合法模式
 */
function readBoardMode(raw, logger) {
  if (raw?.boardMode === undefined) return BOARD_MODE_DEFAULT
  const value = parseBoardMode(raw.boardMode)
  if (value !== undefined) return value
  logger(`dsh-leader-agent: settings.json 的 boardMode 非法，使用默认值 ${BOARD_MODE_DEFAULT}`)
  return BOARD_MODE_DEFAULT
}

/**
 * 创建插件设置存储。
 *
 * @param {object} options - 选项
 * @param {string} options.home - dsh home 目录
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {object} 设置存储接口
 */
export function createSettingsStore({ home, logger = () => {} }) {
  const directory = join(home, 'dsh-leader-agent')
  const file = join(directory, 'settings.json')
  const temporary = join(directory, 'settings.json.tmp')

  /**
   * 当前内存快照。
   *
   * 构造时同步读盘；之后只有 `update` 成功写盘才会替换。读取方向因此没有
   * 「读到一半」的状态，派工器可以直接同步取值。
   * @type {{ autoResumeLimit: number, boardMode: string }}
   */
  let current = { ...DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('设置文件结构非法：顶层必须是对象')
    }
    current = {
      autoResumeLimit: readAutoResumeLimit(parsed, logger),
      boardMode: readBoardMode(parsed, logger),
    }
  } catch (error) {
    // 文件缺失是正常的首次启动；其它读取 / 解析失败要留一行线索，仍按默认值启动。
    if (error?.code !== 'ENOENT') {
      const backup = `${file}.corrupt-${Date.now()}`
      try {
        renameSync(file, backup)
        logger(`dsh-leader-agent: 读取 settings.json 失败，已备份到 ${backup}，使用默认设置：${error instanceof Error ? error.message : String(error)}`)
      } catch (backupError) {
        logger(`dsh-leader-agent: 读取 settings.json 失败，备份到 ${backup} 失败，使用默认设置：${error instanceof Error ? error.message : String(error)}；备份错误：${backupError instanceof Error ? backupError.message : String(backupError)}`)
      }
    }
  }

  /** 写操作的串行链：两次保存并发时不能互相覆盖，也不能抢同一个临时文件。 */
  let tail = Promise.resolve()

  /**
   * 串行执行一次写操作。
   * @template T
   * @param {() => Promise<T>} operation - 写操作
   * @returns {Promise<T>} 操作结果
   */
  function serialize(operation) {
    const run = tail.then(operation, operation)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 原子写回设置文件。
   * @param {{ autoResumeLimit: number, boardMode: string }} next - 新快照
   * @returns {Promise<void>} 写盘完成
   */
  async function write(next) {
    await mkdir(directory, { recursive: true })
    await writeFile(
      temporary,
      `${JSON.stringify({
        version: SETTINGS_VERSION,
        autoResumeLimit: next.autoResumeLimit,
        boardMode: next.boardMode,
      }, null, 2)}\n`,
      'utf8',
    )
    await rename(temporary, file)
  }

  /** @type {Set<(next: object, previous: object) => void>} */
  const listeners = new Set()

  /**
   * 取当前设置快照。
   *
   * 返回副本：调用方改返回值不能污染派工器读到的配置。
   * @returns {{ autoResumeLimit: number, boardMode: string }} 设置快照
   */
  function get() {
    return { ...current }
  }

  /**
   * 更新一个或多个设置字段并落盘。
   *
   * 只接受已知字段；校验失败直接拒绝，不写盘、不改内存。写盘失败也不改内存，
   * 界面据此显示失败，下一次投递仍按旧值判断。写盘成功后才通知订阅者，保证
   * 「读到的值已经持久化」。
   *
   * 合并放在串行链内部：两个并发保存改不同字段时，后一个不能拿旧快照覆盖前一个。
   *
   * @param {{ autoResumeLimit?: unknown, boardMode?: unknown }} patch - 要更新的字段
   * @returns {Promise<{ autoResumeLimit: number, boardMode: string }>} 更新后的快照
   */
  function update(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return Promise.reject(new Error('设置更新必须是一个对象'))
    }
    const keys = Object.keys(patch)
    if (keys.length === 0) return Promise.reject(new Error('设置更新至少需要一个字段'))
    /** @type {{ autoResumeLimit?: number, boardMode?: string }} */
    const nextValues = {}
    for (const key of keys) {
      if (key === 'autoResumeLimit') {
        const value = parseAutoResumeLimit(patch[key])
        if (value === undefined) {
          return Promise.reject(new Error(`自动续行上限必须是 ${AUTO_RESUME_LIMIT_MIN}–${AUTO_RESUME_LIMIT_MAX} 之间的整数`))
        }
        nextValues.autoResumeLimit = value
      } else if (key === 'boardMode') {
        const value = parseBoardMode(patch[key])
        if (value === undefined) {
          return Promise.reject(new Error('看板模式必须是 work 或 cinema'))
        }
        nextValues.boardMode = value
      } else {
        return Promise.reject(new Error(`未知设置项：${key}`))
      }
    }
    return serialize(async () => {
      const previous = current
      const next = { ...previous, ...nextValues }
      await write(next)
      current = next
      for (const listener of listeners) {
        try {
          listener(get(), { ...previous })
        } catch (error) {
          // 订阅者只做内存态释放；抛错不能让已经落盘的设置变成「保存失败」。
          logger(`dsh-leader-agent: 设置变更订阅者失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return get()
    })
  }

  /**
   * 订阅设置变更。
   * @param {(next: object, previous: object) => void} listener - 回调
   * @returns {() => void} 退订函数
   */
  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { file, get, update, subscribe }
}
