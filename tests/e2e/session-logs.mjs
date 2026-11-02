/**
 * 读数据根下的会话日志文本，供「落盘断言」使用。
 *
 * 会话日志的真实布局是 `sessions/<cwd 编码>/session-<id>/session.v4.jsonl[.zstd]`，
 * 但层级与格式版本都属于宿主内部实现：这里递归找文件、两种后缀都认，写死路径会
 * 随版本漂移，而失败时看不出是编码变了还是日志没写。
 *
 * @module dsh-leader-kit/tests/e2e/session-logs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/**
 * 解压一份日志；正在写的 zstd 帧解不出来时返回 null。
 *
 * @param {string} name - 文件名
 * @param {Buffer} raw - 文件内容
 * @returns {string | null} 文本
 */
function decode(name, raw) {
  if (name.endsWith('.jsonl')) return raw.toString('utf8')
  if (!name.endsWith('.jsonl.zstd')) return null
  try {
    return zstdDecompressSync(raw).toString('utf8')
  } catch (_partialFrame) {
    // 会话正在写：这一轮读到的是未完整的帧，调用方下一轮轮询再读。
    return null
  }
}

/**
 * 读出所有会话日志的文本。
 *
 * @param {string} home - 实例数据根
 * @returns {string[]} 每份日志的文本
 */
export function readSessionLogs(home) {
  const sessionsRoot = join(home, 'sessions')
  if (!existsSync(sessionsRoot)) return []
  const texts = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const text = decode(entry.name, readFileSync(path))
      if (text !== null) texts.push(text)
    }
  }
  walk(sessionsRoot)
  return texts
}

/**
 * 某段文本是否已落进任意一份会话日志。
 *
 * @param {string} home - 实例数据根
 * @param {string} needle - 要找的文本
 * @returns {boolean} 命中为 true
 */
export function sessionLogsContain(home, needle) {
  return readSessionLogs(home).some((text) => text.includes(needle))
}
