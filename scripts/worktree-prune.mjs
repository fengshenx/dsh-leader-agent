/**
 * 清理已合并的 worktree。
 *
 * 默认只打印结论（dry-run），`--apply` 才真的删。判据见 `classifyWorktree`：
 * 有未提交改动、当前所在的 worktree、分支没进 main 且 PR 未合并——任一命中就拒绝。
 *
 * 删除顺序：先把 `.dev` 挪到 `.worktrees/.dev-stash-<任务名>`（remove 失败时挪回），
 * 再拆 worktree 里的 node_modules 链接（只拆链接本身，Windows junction 用 rmdir、
 * POSIX 符号链接用 unlink），最后 `git worktree remove --force` 清目录。不先拆的话，
 * git 在 Windows 上会跟随 junction 递归删掉主 checkout 的依赖（实测）；`.dev` 里
 * dev 实例的逐条链接同理。删除成功后才删暂存；失败路径恢复链接、把 `.dev` 挪回，
 * 恢复不了时在错误信息里写明残留位置。已合并的分支一并删本地引用；远端分支默认保留，
 * `--delete-remote` 才删（远端名由 `--remote` 指定，默认 origin）。
 *
 * 用法：
 *   node scripts/worktree-prune.mjs                     # 扫描全部，只打印
 *   node scripts/worktree-prune.mjs --apply             # 删可删的
 *   node scripts/worktree-prune.mjs my-task --apply     # 只处理 my-task
 *   node scripts/worktree-prune.mjs --apply --delete-remote
 *   node scripts/worktree-prune.mjs --apply --delete-remote --remote upstream
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  assertTaskName, classifyWorktree, detachNodeModulesLink, lstatIfExists, teardownWorktree, worktreeDirFor,
} from './worktree-common.mjs'

/**
 * 跑一条命令，返回结果而不抛错。
 *
 * @param {string} command - 可执行文件
 * @param {string[]} args - 参数
 * @param {string} cwd - 工作目录
 * @returns {{ status: number | null, stdout: string, stderr: string }} 结果
 */
function call(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * 查分支的 PR 状态。
 *
 * @param {string} branch - 分支名
 * @param {string} cwd - 在主 checkout 里执行
 * @returns {{ state: string, number: number, url: string } | null | undefined} MERGED/OPEN/CLOSED；
 *   `null` 是没有 PR，`undefined` 是查不到（gh 不可用或未登录）
 */
function pullRequestOf(branch, cwd) {
  const result = call('gh', [
    'pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state,url',
  ], cwd)
  if (result.status !== 0) return undefined
  let parsed
  try {
    parsed = JSON.parse(result.stdout || '[]')
  } catch {
    // 输出不是 JSON（gh 版本差异、被包装脚本改写、登录态坏了）＝查不到，
    // 按 classifyWorktree 的语义拒绝删除，而不是在这里崩栈
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  return { state: parsed[0].state, number: parsed[0].number, url: parsed[0].url }
}

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const deleteRemote = argv.includes('--delete-remote')
const remoteIndex = argv.indexOf('--remote')
const remote = remoteIndex === -1 ? 'origin' : argv[remoteIndex + 1]
// --remote 后面那个词是远端名，不能当成任务名（没有 --remote 时 -1 + 1 = 0 会误吞第一个位置参数）
const only = argv.find((arg, index) => !arg.startsWith('--') && (remoteIndex === -1 || index !== remoteIndex + 1))

if (remoteIndex !== -1 && (remote === undefined || remote.startsWith('--'))) {
  console.error('错误: --remote 需要远端名')
  process.exit(1)
}
if (only !== undefined) {
  try {
    assertTaskName(only)
  } catch (error) {
    console.error(`错误: ${error.message}`)
    process.exit(1)
  }
}

// 主 checkout 根：本脚本可能从某个将被删掉的 worktree 里调用，cwd 会随目录消失失效
const commonDir = call('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], process.cwd())
if (commonDir.status !== 0) {
  console.error('错误: 当前目录不在 git 仓库里')
  process.exit(1)
}
const root = dirname(commonDir.stdout.trim())
const here = call('git', ['rev-parse', '--show-toplevel'], process.cwd()).stdout.trim()
const worktreesRoot = join(root, '.worktrees')

/**
 * 先拆 node_modules 链接，再执行删除动作。
 *
 * 不能直接 `git worktree remove --force`：Windows 上 git 会跟穿 junction，把主
 * checkout 的 node_modules 清空（实测）。
 *
 * @template T
 * @param {string} dir - worktree 目录
 * @param {() => T} remove - 删除动作
 * @returns {T} remove 的返回值
 */
function teardown(dir, remove) {
  return teardownWorktree({
    dir,
    platform: process.platform,
    stat: lstatIfExists,
    detach: detachNodeModulesLink,
    remove,
  })
}

/**
 * 把 `.dev` 挪到 `git worktree remove` 不会碰到的位置。
 *
 * remove 失败时 worktree 还留着，里面的开发实例数据不能先丢；先挪走、成功后再删。
 * 暂存目录用隐藏名放在 `.worktrees` 下，不参与本脚本的扫描，重跑时会接管残留。
 *
 * @param {string} dir - worktree 目录
 * @param {string} name - 任务名
 * @returns {{ dev: string, stash: string, moved: boolean }} 原路径、暂存路径与是否有待处理的 `.dev`
 */
function stashDev(dir, name) {
  const dev = join(dir, '.dev')
  const stash = join(worktreesRoot, `.dev-stash-${name}`)
  if (!existsSync(dev)) return { dev, stash, moved: existsSync(stash) }
  if (existsSync(stash)) throw new Error(`.dev 与暂存目录同时存在: ${stash}`)
  renameSync(dev, stash)
  return { dev, stash, moved: true }
}

/**
 * 把 `.dev` 挪回 worktree。
 *
 * @param {{ dev: string, stash: string, moved: boolean }} state - `stashDev` 的结果
 * @returns {string} 追加到错误信息后的状态说明；没有待恢复的数据时为空串
 */
function restoreDevStatus(state) {
  if (!state.moved) return ''
  try {
    renameSync(state.stash, state.dev)
    return '，.dev 已挪回'
  } catch (error) {
    return `，.dev 暂存在 ${state.stash}（挪回失败: ${error.message}）`
  }
}

/**
 * 删除失败时把 node_modules 链接补回去，别留下「链接已拆、worktree 还在」的状态。
 *
 * @param {string} dir - worktree 目录
 * @param {boolean} hadLink - 删除前是否确实有链接
 * @returns {string} 追加到错误信息后的状态说明；不需要恢复时为空串
 */
function restoreNodeModulesLink(dir, hadLink) {
  if (!hadLink) return ''
  try {
    const link = join(dir, 'node_modules')
    if (lstatIfExists(link) !== null) return ''
    symlinkSync(join(root, 'node_modules'), link, process.platform === 'win32' ? 'junction' : 'dir')
    return '，node_modules 链接已恢复'
  } catch (error) {
    return `，node_modules 链接恢复失败（${error.message}）`
  }
}

if (!existsSync(worktreesRoot)) {
  console.log('没有 .worktrees 目录，无需清理')
  process.exit(0)
}

const names = only !== undefined
  ? [only]
  : readdirSync(worktreesRoot).filter((name) => !name.startsWith('.')
    && lstatSync(join(worktreesRoot, name), { throwIfNoEntry: false })?.isDirectory() === true)
const rows = []
for (const name of names) {
  const dir = worktreeDirFor(root, name)
  if (!existsSync(dir)) continue
  const head = call('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], root)
  if (head.status !== 0) {
    rows.push({ name, dir, branch: '', verdict: { removable: false, reason: 'worktree 登记失效（git 读不出分支）' } })
    continue
  }
  const branch = head.stdout.trim()
  if (branch === 'main') {
    rows.push({ name, dir, branch, verdict: { removable: false, reason: 'main 分支不删' } })
    continue
  }
  const dirty = call('git', ['-C', dir, 'status', '--porcelain'], root).stdout.trim() !== ''
  const mergedIntoMain = call('git', ['merge-base', '--is-ancestor', branch, 'main'], root).status === 0
  // 已进 main 时 classifyWorktree 直接放行，不必再问 gh——离线时也不会白等
  const pullRequest = mergedIntoMain ? undefined : pullRequestOf(branch, root)
  const verdict = classifyWorktree({
    isCurrent: here === dir,
    dirty,
    mergedIntoMain,
    pullRequest,
  })
  rows.push({ name, dir, branch, verdict })
}

console.log('')
console.log('  任务              分支                             结论')
console.log('  ' + '-'.repeat(84))
for (const row of rows) {
  const mark = row.verdict.removable ? '✓' : '✗'
  console.log(`  ${mark} ${row.name.padEnd(16)} ${(row.branch || '(未知)').padEnd(32)} ${row.verdict.reason}`)
}
console.log('')

const removable = rows.filter((row) => row.verdict.removable)
if (!apply) {
  console.log(removable.length === 0 ? '没有可清理的 worktree' : `${removable.length} 个可清理；加 --apply 执行`)
  if (removable.length > 0) console.log('注意：删 worktree 会连带清掉它里面的 .dev/home（开发实例的会话、项目、卡片数据）')
  process.exit(0)
}
if (removable.length === 0) {
  console.log('没有可清理的 worktree')
  process.exit(0)
}
// 在将要删除的 worktree 里执行时，删到自己那一步 cwd 就失效了，所以从主 checkout 跑
process.chdir(root)
for (const row of removable) {
  const hadLink = lstatIfExists(join(row.dir, 'node_modules'))?.isSymbolicLink() === true
  let devState
  try {
    // 先挪 .dev，再拆链接：挪不动就停在「什么都没改」的状态，不会出现链接已拆、
    // .dev 也删了一半的残局。
    devState = stashDev(row.dir, row.name)
  } catch (error) {
    console.error(`[失败] ${row.name}: 挪走 .dev 失败，worktree 未动（${error.message}）`)
    continue
  }
  let removed
  try {
    removed = teardown(row.dir, () => call('git', ['worktree', 'remove', row.dir, '--force'], root))
  } catch (error) {
    console.error(`[失败] ${row.name}: 拆 node_modules 链接失败，worktree 未删（${error.message}）${restoreDevStatus(devState)}${restoreNodeModulesLink(row.dir, hadLink)}`)
    continue
  }
  if (removed.status !== 0) {
    console.error(`[失败] ${row.name}: git worktree remove 失败（${removed.stderr.trim()}）；worktree 保留${restoreDevStatus(devState)}${restoreNodeModulesLink(row.dir, hadLink)}`)
    continue
  }
  if (devState.moved) {
    try {
      rmSync(devState.stash, { recursive: true, force: true })
    } catch (error) {
      console.error(`[警告] ${row.name}: .dev 暂存目录删除失败（${error.message}），残留在 ${devState.stash}`)
    }
  }
  let remoteNote = ''
  // worktree remove 偶尔留下空壳目录（`--force` 之外的残留）。兜底也走同一套
  // 拆除流程：真出现链接时先拆再删，rmSync 不会跟穿到主 checkout。
  if (existsSync(row.dir)) {
    try {
      teardown(row.dir, () => rmSync(row.dir, { recursive: true, force: true }))
    } catch (error) {
      console.error(`[失败] ${row.name}: 清理残留目录失败（${error.message}）`)
      continue
    }
  }
  if (row.branch !== '') {
    call('git', ['branch', '-D', row.branch], root)
    if (deleteRemote) {
      const pushed = call('git', ['push', remote, '--delete', row.branch], root)
      if (pushed.status === 0) {
        remoteNote = `，含远端 ${remote}`
      } else {
        // 只取首行：git 的失败输出常常是四五行建议，挤在一句里没法读
        console.error(`[远端未删] ${row.branch}: ${pushed.stderr.trim().split('\n')[0]}（本地已删，远端分支还在）`)
      }
    }
  }
  console.log(`[已删] ${row.name}（${row.branch}${remoteNote}）`)
}
