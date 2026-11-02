/**
 * 原子替换与跨进程写者锁的本地实现，供 `scripts/dev.mjs` 写凭据文件用。
 *
 * 为什么不 import 宿主的 `@deepseek-ai/dsh-atomic-write`：本仓是仓外插件，不依赖
 * 宿主的内部包（理由见 `src/host/message.js` 头注释）。这里照宿主的协议实现本脚本
 * 需要的那部分——临时文件独占创建、带上目标权限位，再 rename 覆盖，读者只会看到
 * 旧或新的完整内容；写者锁是同目录下的 `<文件名>.lock`，与宿主 `withFileLock` 的
 * 路径与内容一致，所以 `npm run dev` 与正在运行的实例不会同时改同一份凭据文件。
 *
 * 与宿主的差异只有死锁接管：宿主用 claim 文件串行化接管，这里直接按 PID 探活后
 * 删除。差别落在两个进程同时判定同一个锁的持有者已退出的极端窗口——此时最多多
 * 一次 EEXIST 重试，不会让两个写者同时持锁。PID 复用与宿主一样不处理。
 *
 * @module dsh-leader-kit/scripts/atomic-write
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Windows 上杀软或句柄能让 rename 短暂失败，退避重试有限次。 */
const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM'])
const RENAME_RETRY_LIMIT = 5

/** 同步等待（脚本是同步风格，没有事件循环可让）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** rename 提交，Windows 上的瞬时失败退避重试。 */
function renameOver(temp, filename) {
  let delay = 20
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, filename)
      return
    } catch (error) {
      if (process.platform !== 'win32'
        || !WINDOWS_TRANSIENT_RENAME_ERRORS.has(error.code)
        || attempt >= RENAME_RETRY_LIMIT) throw error
    }
    sleepSync(delay)
    delay = Math.min(delay * 2, 200)
  }
}

/**
 * 原子替换 `filename`：先写独占创建的临时文件，再 rename 覆盖。
 *
 * `mode` 落在临时文件的 inode 上并随 rename 生效，所以替换一个权限更宽的旧文件
 * 是收紧而不是留有可读窗口；新文件创建到 rename 之间读者看不到它。
 *
 * @param {string} filename - 目标文件
 * @param {string} content - 完整的新内容
 * @param {object} options - 选项
 * @param {number} options.mode - 目标文件的权限位（受 umask 约束）
 * @param {number} [options.dirMode] - 新建父目录的权限位
 * @returns {void} 无返回
 */
export function writeFileAtomicSync(filename, content, { mode, dirMode }) {
  mkdirSync(dirname(filename), {
    recursive: true,
    ...dirMode === undefined ? {} : { mode: dirMode },
  })
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, content, { mode, flag: 'wx' })
    renameOver(temp, filename)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/**
 * 锁的持有者进程是否已经不在。
 *
 * 记录被写了一半、或 PID 指向本进程时什么也证明不了，按「仍在持有」处理。
 *
 * @param {string} lockPath - 锁文件
 * @returns {boolean} 能证明持有者已退出时为 true
 */
function takeOverExitedLock(lockPath) {
  let record
  try {
    record = readFileSync(lockPath, 'utf8')
  } catch {
    return false
  }
  if (!/^\d+\n$/.test(record)) return false
  const pid = Number(record)
  if (pid === 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error.code !== 'ESRCH') return false
  }
  try {
    rmSync(lockPath, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 持有 `filename` 的写者锁执行一次读-改-写。
 *
 * 锁文件用独占创建占位、内容是持有者 PID，与宿主 `withFileLock` 同一协议；
 * 读者不需要锁，rename 提交已经保证他们看到完整内容。
 *
 * @param {string} filename - 被保护的文件
 * @param {() => *} operation - 持锁期间执行的读-改-写
 * @param {object} [options] - 选项
 * @param {number} [options.waitMs] - 等锁上限，默认 2000
 * @returns {*} operation 的返回值
 */
export function withFileLockSync(filename, operation, { waitMs = 2000 } = {}) {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + waitMs
  let delay = 20
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (takeOverExitedLock(lockPath)) continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待写者锁超时（${lockPath}）；没有实例在运行时删掉它再试`)
    }
    sleepSync(delay)
    delay = Math.min(delay * 2, 200)
  }
  try {
    return operation()
  } finally {
    // 只删自己那把：极端情况下锁可能已被接管，删别人的会放出第二个写者。
    try {
      if (readFileSync(lockPath, 'utf8') === `${process.pid}\n`) rmSync(lockPath, { force: true })
    } catch {
      // 锁已被别人接管或删除，没有可回收的东西。
    }
  }
}
