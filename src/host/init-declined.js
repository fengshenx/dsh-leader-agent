/**
 * 「用户不要初始化手册」标记的存储。
 *
 * 落 dsh 数据域（`<home>/dsh-leader-kit/init-declined/`），不写用户仓库：写进项目
 * 目录会让 `git status` 多出一个未跟踪目录，`git add -A` 会把它提交进去。
 *
 * 一个项目一个文件，按项目目录哈希命名（带目录名便于人工排查）；判定只看文件
 * 是否存在，所以删除后下一轮求值就恢复提示，不需要重启。
 *
 * @module dsh-leader-kit/host/init-declined
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * 创建拒绝初始化标记的存储。
 *
 * @param {object} options - 选项
 * @param {string} options.home - dsh home 目录
 * @returns {{ directory: string, fileOf: (projectDirectory: string) => string, isDeclined: (projectDirectory: string) => boolean }} 存储接口
 */
export function createInitDeclinedStore({ home }) {
  const directory = join(home, 'dsh-leader-kit', 'init-declined')

  /**
   * 标记文件路径。
   * @param {string} projectDirectory - 项目目录绝对路径
   * @returns {string} 标记文件绝对路径
   */
  function fileOf(projectDirectory) {
    const key = createHash('sha256').update(projectDirectory).digest('hex').slice(0, 12)
    const name = basename(projectDirectory).replace(/[^\w.-]+/g, '-').slice(0, 40)
    return join(directory, `${name === '' ? 'project' : name}-${key}`)
  }

  /**
   * 该项目是否被明确拒绝过初始化。
   * @param {string} projectDirectory - 项目目录绝对路径
   * @returns {boolean} 是否已拒绝
   */
  function isDeclined(projectDirectory) {
    if (typeof projectDirectory !== 'string' || projectDirectory === '') return false
    return existsSync(fileOf(projectDirectory))
  }

  return { directory, fileOf, isDeclined }
}
