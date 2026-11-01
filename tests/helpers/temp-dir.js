/**
 * 测试用的临时目录：建完登记，测试结束后统一删。
 *
 * 让每个用例自己 `rm` 很容易漏——本仓曾因此在系统 temp 里堆了四千多个
 * `dsh-leader-kit-*` 目录。改由这里统一登记，测试文件的 `after` 钩子调用
 * `cleanupTempDirs` 收尾。
 *
 * @module dsh-leader-kit/tests/helpers/temp-dir
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 本进程建过的临时目录。 */
const created = []

/**
 * 建一个临时目录，登记待清理。
 * @param {string} prefix - 目录名前缀
 * @returns {Promise<string>} 目录路径
 */
export async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/**
 * 删掉本进程建过的全部临时目录。
 *
 * 逐个删而不是一把删父目录：这些目录同级，删父目录会连别人的一起删掉。
 *
 * @returns {Promise<void>}
 */
export async function cleanupTempDirs() {
  // 重试：目录可能正被在途写盘占用，删一次撞上 ENOTEMPTY / ENOENT 就再试。
  await Promise.all(created.map((dir) => rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })))
  created.length = 0
}
