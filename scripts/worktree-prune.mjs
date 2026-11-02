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
 * `--apply` 全程持有 `.worktrees/.prune.lock`（`wx` 创建，stale 锁按 PID/TTL 回收）：
 * 同一仓库同时只允许一个 prune。否则两个进程会一边拆链接、一边在恢复分支重建链接，
 * 正在 `git worktree remove` 的那个会把刚恢复的 junction 一起跟穿。
 *
 * 用法：
 *   node scripts/worktree-prune.mjs                     # 扫描全部，只打印
 *   node scripts/worktree-prune.mjs --apply             # 删可删的
 *   node scripts/worktree-prune.mjs my-task --apply     # 只处理 my-task
 *   node scripts/worktree-prune.mjs --apply --delete-remote
 *   node scripts/worktree-prune.mjs --apply --delete-remote --remote upstream
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
 * 读 node_modules 链接的原始 target。相对路径按链接所在目录解析，恢复时才能
 * 指回原处，而不是把自定义共享依赖悄悄改回主 checkout。
 *
 * @param {string} link - 链接路径
 * @returns {string | null} 绝对 target；读不出来时 null
 */
function linkTargetOf(link) {
  try {
    const target = readlinkSync(link)
    return isAbsolute(target) ? target : resolve(dirname(link), target)
  } catch {
    return null
  }
}

/**
 * 删除失败时把 node_modules 链接补回去，别留下「链接已拆、worktree 还在」的状态。
 *
 * @param {string} dir - worktree 目录
 * @param {boolean} hadLink - 删除前是否确实有链接
 * @param {string | null} target - 删除前读到的原 target
 * @returns {string} 追加到错误信息后的状态说明；不需要恢复时为空串
 */
function restoreNodeModulesLink(dir, hadLink, target) {
  if (!hadLink) return ''
  try {
    const link = join(dir, 'node_modules')
    if (lstatIfExists(link) !== null) return ''
    if (target === null || !existsSync(target)) return '，node_modules 链接未恢复（原 target 不可用）'
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return '，node_modules 链接已恢复'
  } catch (error) {
    return `，node_modules 链接恢复失败（${error.message}）`
  }
}

/**
 * worktree 是否还登记在 git 里。`git worktree remove` 失败时可能已经先注销，
 * 之后重跑 prune 会把它当成主仓里的目录，永远不会再处理。
 *
 * @param {string} dir - worktree 目录
 * @returns {boolean | undefined} 登记状态；git 查询失败时 undefined
 */
function worktreeRegistered(dir) {
  const listed = call('git', ['worktree', 'list', '--porcelain', '-z'], root)
  if (listed.status !== 0) return undefined
  const target = normalizePath(dir)
  return listed.stdout.split('\0').some((record) => record.startsWith('worktree ')
    && normalizePath(record.slice('worktree '.length)) === target)
}

/**
 * @param {string} path - 路径
 * @returns {string} 用于比较的规范化路径
 */
function normalizePath(path) {
  const resolved = resolve(path).replace(/\\/g, '/')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const LOCK_PATH = join(worktreesRoot, '.prune.lock')
const LOCK_TTL_MS = 10 * 60 * 1000

/**
 * 读 prune 锁。
 *
 * @returns {{ raw: string, pid?: number, token?: string, startedAt?: number, invalid?: boolean, mtimeMs?: number } | null} 锁内容
 */
function readPruneLock() {
  let raw
  try {
    raw = readFileSync(LOCK_PATH, 'utf8')
  } catch {
    return null
  }
  try {
    const data = JSON.parse(raw)
    return { raw, pid: data.pid, token: data.token, startedAt: data.startedAt }
  } catch {
    try {
      return { raw, invalid: true, mtimeMs: statSync(LOCK_PATH).mtimeMs }
    } catch {
      return null
    }
  }
}

/**
 * 锁是否可回收：PID 不存在、超过 TTL，或写了一半的锁文件已存在足够久。
 *
 * @param {ReturnType<typeof readPruneLock>} lock - 锁内容
 * @returns {boolean} 是否可回收
 */
function lockIsStale(lock) {
  if (lock === null) return true
  if (lock.invalid) return Date.now() - lock.mtimeMs > 5000
  if (!Number.isInteger(lock.pid) || lock.pid <= 0) return true
  if (typeof lock.startedAt !== 'number' || Date.now() - lock.startedAt > LOCK_TTL_MS) return true
  try {
    process.kill(lock.pid, 0)
    return false
  } catch (error) {
    // EPERM 说明进程还在，只是没权限发信号；ESRCH 才是真没了
    return error.code !== 'EPERM'
  }
}

/**
 * 抢仓库级 prune 锁。`--apply` 全程独占，避免两个进程在同一个 worktree 上
 * 一边拆链接一边恢复链接，让 git 跟穿到主 checkout 的依赖。
 *
 * @returns {string | null} 本次持锁的 token；抢不到时 null
 */
function acquirePruneLock() {
  const token = randomUUID()
  const payload = JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(LOCK_PATH, 'wx')
      try {
        writeFileSync(fd, payload)
      } finally {
        closeSync(fd)
      }
      return token
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const current = readPruneLock()
      if (!lockIsStale(current)) {
        console.error(`错误: 另一个 prune 正在运行（PID ${current?.pid ?? '未知'}，锁 ${LOCK_PATH}），本次退出`)
        return null
      }
      try {
        // 只清自己刚读到的那一份，避免把并发进程刚建的新锁删掉
        if (current !== null && readFileSync(LOCK_PATH, 'utf8') === current.raw) unlinkSync(LOCK_PATH)
      } catch {
        // 另一个进程已经清掉或替换了它，下一轮重试
      }
    }
  }
  console.error(`错误: 拿不到 prune 锁 ${LOCK_PATH}，可能仍被另一个进程占用`)
  return null
}

/**
 * 释放自己持有的 prune 锁；锁已被回收时不碰别人的锁。
 *
 * @param {string} token - `acquirePruneLock` 返回的 token
 * @returns {void} 无返回
 */
function releasePruneLock(token) {
  try {
    if (readPruneLock()?.token === token) unlinkSync(LOCK_PATH)
  } catch (error) {
    console.error(`[警告] 释放 prune 锁失败（${error.message}），下次会按 PID/TTL 回收: ${LOCK_PATH}`)
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
const lockToken = acquirePruneLock()
if (lockToken === null) process.exit(1)
try {
  // 在将要删除的 worktree 里执行时，删到自己那一步 cwd 就失效了，所以从主 checkout 跑
  process.chdir(root)
  for (const row of removable) {
    // 扫描与拿锁之间另一个 prune 可能已经删掉它；别把已经完成的删除报成失败
    if (!existsSync(row.dir)) {
      console.log(`[跳过] ${row.name}: 已被另一个 prune 删除`)
      continue
    }
    const link = join(row.dir, 'node_modules')
    const hadLink = lstatIfExists(link)?.isSymbolicLink() === true
    const linkTarget = hadLink ? linkTargetOf(link) : null
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
      console.error(`[失败] ${row.name}: 拆 node_modules 链接失败，worktree 未删（${error.message}）${restoreDevStatus(devState)}${restoreNodeModulesLink(row.dir, hadLink, linkTarget)}`)
      continue
    }
    if (removed.status !== 0) {
      const registered = worktreeRegistered(row.dir)
      const devNote = restoreDevStatus(devState)
      if (registered === false) {
        // git 可能已经先注销再失败；此时恢复链接等于制造一个没人管理的 junction
        console.error(`[失败] ${row.name}: git worktree remove 失败（${removed.stderr.trim()}）；git 已注销该 worktree，重跑 prune 不会处理，请手工删除目录${devNote}${hadLink ? '，node_modules 链接已拆且不恢复' : ''}`)
      } else if (registered === undefined) {
        console.error(`[失败] ${row.name}: git worktree remove 失败（${removed.stderr.trim()}）；无法确认 worktree 是否仍登记，重跑前先检查；node_modules 链接未恢复${devNote}`)
      } else {
        console.error(`[失败] ${row.name}: git worktree remove 失败（${removed.stderr.trim()}）；worktree 保留${devNote}${restoreNodeModulesLink(row.dir, hadLink, linkTarget)}`)
      }
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
        console.error(`[失败] ${row.name}: 清理残留目录失败（${error.message}）；worktree 已注销，重跑 prune 不会处理，请手工删除目录`)
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
} finally {
  releasePruneLock(lockToken)
}
