/**
 * worktree 命名与目录约定。
 *
 * 与 `npm run dev` 无关的部分不放在这里：这些函数只回答「任务名合法吗、目录在
 * 哪、分支叫什么」，供 `worktree-spawn.mjs` 与测试共用。
 *
 * @module dsh-leader-kit/scripts/worktree-common
 */

import { join } from 'node:path'

/** 任务名允许的字符：字母数字开头，之后可带点、下划线、连字符。 */
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 校验任务名。
 *
 * 任务名会拼进目录路径与 git 分支名，所以拦掉路径穿越（`..`）、分隔符与空白——
 * 这类名字建出来不是落在 `.worktrees/` 里，就是让 `git worktree add` 报一个
 * 看不懂的错。
 *
 * @param {string} name - 任务名
 * @returns {void} 合法时无返回
 */
export function assertTaskName(name) {
  if (typeof name !== 'string' || name === '') {
    throw new Error('任务名不能为空')
  }
  if (!TASK_NAME.test(name)) {
    throw new Error(`任务名不合法: ${name}（只允许字母数字开头的字母数字、点、下划线、连字符）`)
  }
}

/**
 * 任务对应的分支名。
 *
 * @param {string} name - 任务名
 * @returns {string} 分支名
 */
export function branchFor(name) {
  return `feature/${name}`
}

/**
 * 任务对应的 worktree 目录。
 *
 * @param {string} root - 主 checkout 的绝对路径
 * @param {string} name - 任务名
 * @returns {string} worktree 的绝对路径
 */
export function worktreeDirFor(root, name) {
  return join(root, '.worktrees', name)
}

/**
 * 判断一个 worktree 能不能清掉。
 *
 * 判据顺序是「先把会丢东西的理由排掉」：有未提交改动一定拒绝（那是还没进版本
 * 的工作），其次是当前所在的 worktree（删到一半 cwd 会失效），再看分支是否已进
 * main，最后才看 PR 状态。
 *
 * 两条「已合并」判据都留着，因为合并方式不设限：走 merge commit 时
 * `merge-base --is-ancestor` 成立；走 squash 时不成立，但 PR 状态仍是 MERGED。
 * 任一成立即可删。
 *
 * @param {object} options - 选项
 * @param {boolean} options.isCurrent - 是否是当前所在的 worktree
 * @param {boolean} options.dirty - 是否有未提交或未跟踪的改动
 * @param {boolean} options.mergedIntoMain - 分支是否已进 main
 * @param {{ state: string, number: number, url: string } | null | undefined} options.pullRequest - 分支的 PR；
 *   `undefined` 表示查不到（gh 不可用），`null` 表示没有任何 PR
 * @returns {{ removable: boolean, reason: string }} 判定
 */
export function classifyWorktree({ isCurrent, dirty, mergedIntoMain, pullRequest }) {
  // 未提交的改动排在前面：它比「cd 出去再来」更难自救，先说这条更有用
  if (dirty) return { removable: false, reason: '有未提交的改动' }
  if (isCurrent) return { removable: false, reason: '当前所在的 worktree，先 cd 到主 checkout' }
  if (mergedIntoMain) return { removable: true, reason: '分支已进 main' }
  if (pullRequest === undefined) return { removable: false, reason: '查不到 PR 状态（gh 不可用或未登录）' }
  if (pullRequest === null) return { removable: false, reason: '分支没有 PR 记录' }
  if (pullRequest.state === 'MERGED') {
    return { removable: true, reason: `PR #${pullRequest.number} 已合并` }
  }
  if (pullRequest.state === 'OPEN') return { removable: false, reason: `PR #${pullRequest.number} 还开着` }
  return { removable: false, reason: `PR #${pullRequest.number} 已关闭但未合并` }
}
