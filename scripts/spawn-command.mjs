/**
 * 起 `npm` / `dsh` 子进程，绕过 Windows 上 shim 不可直接执行的问题。
 *
 * Windows 上 `npm i -g` 装的命令入口是三个 shim：给 cmd 的 `dsh.cmd`、给 PowerShell
 * 的 `dsh.ps1`、给 git bash 等 sh 的 `dsh`（无扩展名），没有 `dsh.exe`。于是
 * `spawnSync('dsh')` 报 ENOENT——libuv 只按 `<名>`、`<名>.exe`、`<名>.com` 找文件，
 * 那份无扩展名的 sh 脚本命中了也起不来；指名 `dsh.cmd` 又会被 Node 拒掉（20.12 起
 * `shell: false` 下执行批处理直接 EINVAL，CVE-2024-27980）。所以 Windows 上先按
 * PATHEXT 把名字解析成绝对路径，再交给 `%ComSpec%` 执行——npm 自己起脚本也是这么做的。
 *
 * 解析与命令行拼装是纯函数（`resolveExecutable` / `buildCommandLine`），文件系统
 * 探测从 `exists` 注入，测试不碰真实的 PATH。
 *
 * @module dsh-leader-kit/scripts/spawn-command
 */

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Windows 上可以直接起进程的扩展名，按 PATHEXT 的默认顺序。 */
export const WINDOWS_EXTENSIONS = Object.freeze(['.exe', '.cmd', '.bat', '.com'])

/**
 * 命令不在 PATH 上（或显式路径不存在）。
 *
 * 调用方要靠它区分「没装 / 不在 PATH」与「装坏了、退出码非零」——两者给用户的
 * 修法完全不同。
 */
export class CommandNotFoundError extends Error {
  /**
   * @param {string} command - 原始命令名或路径
   */
  constructor(command) {
    super(`找不到可执行文件: ${command}`)
    this.name = 'CommandNotFoundError'
    this.command = command
  }
}

/**
 * 取 PATH 的值。
 *
 * Windows 的环境变量名大小写不敏感，`Path` 与 `PATH` 都可能出现；调用方传入普通
 * 对象时不会自动归一。`{ ...process.env, PATH }` 这种写法会同时带上原作里的
 * `Path`，所以先认精确的 `PATH`。
 *
 * @param {object} env - 环境变量
 * @returns {string} PATH 的值，没有时为空串
 */
export function pathValueOf(env) {
  if (env.PATH !== undefined) return String(env.PATH)
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  return key === undefined ? '' : String(env[key])
}

/**
 * 默认的存在性探测：目录不算。
 *
 * `existsSync` 会把 PATH 上与命令同名的目录认下来，解析结果随后以「退出码 1 + 空输出」
 * 的形式落到调用方，看不出真实原因是「解析到的是目录」。
 *
 * @param {string} path - 候选路径
 * @returns {boolean} 是否是文件
 */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    // statSync 对不存在的路径抛 ENOENT，「不存在」正是这里要回答的。
    return false
  }
}

/**
 * 起不来 Windows 的命令解释器。
 *
 * 与 `CommandNotFoundError` 分开：那一个说的是「用户的命令没装」，按提示查 PATH 能修；
 * 这一个说的是 `cmd.exe` 本身起不来，修法完全不同。混在一起会把用户引到自己的命令上。
 */
export class CommandShellError extends Error {
  /**
   * @param {string} shell - cmd.exe 的路径
   * @param {Error} cause - `spawnSync` 给出的错误
   */
  constructor(shell, cause) {
    super(`起不了 Windows 命令解释器 ${shell}：${cause.message}`)
    this.name = 'CommandShellError'
    this.shell = shell
  }
}

/**
 * 取 cmd.exe 的绝对路径。
 *
 * 只读父进程的 `process.env`，不读调用方传给子进程的 `env`：libuv 起 `cmd.exe` 时按
 * `options.env` 的 PATH 查找，调用方把 PATH 收窄（比如只留一个临时目录）就找不到它，
 * 而错误会落到「找不到你的命令」上。相对路径的 `ComSpec` 同理不可用。
 *
 * @returns {string} cmd.exe 的绝对路径
 */
function cmdPath() {
  const configured = process.env.ComSpec
  if (configured !== undefined && isAbsolute(configured)) return configured
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'system32', 'cmd.exe')
}

/**
 * 按 PATHEXT 的规则把命令名解析成可执行文件的绝对路径。
 *
 * 无扩展名的同名文件不算命中：Windows 上那是给 sh 用的脚本，`cmd` 起不来它。
 *
 * @param {object} options - 选项
 * @param {string} options.command - 命令名（`dsh`）或路径（`/opt/dsh/bin/dsh`）
 * @param {string} [options.pathValue] - PATH 原值，按 `;` 分隔
 * @param {(path: string) => boolean} [options.exists] - 文件存在性探测
 * @param {readonly string[]} [options.extensions] - 扩展名候选，按优先级
 * @returns {string | null} 绝对路径；找不到时为 null
 */
export function resolveExecutable({ command, pathValue = '', exists = isFile, extensions = WINDOWS_EXTENSIONS }) {
  const lower = command.toLowerCase()
  const candidates = extensions.some((ext) => lower.endsWith(ext)) ? [command] : extensions.map((ext) => `${command}${ext}`)

  // 给了路径就只在那一处找：`DSH_DSH/DEV_DSH` 指向别处的 dsh 时，不该被 PATH
  // 上的同名文件顶替。
  if (/[\\/]/.test(command)) {
    return candidates.find((candidate) => exists(candidate)) ?? null
  }

  for (const raw of pathValue.split(';')) {
    const directory = raw.trim().replace(/^"(.*)"$/, '$1')
    if (directory === '') continue
    for (const candidate of candidates) {
      const path = join(directory, candidate)
      if (exists(path)) return path
    }
  }
  return null
}

/**
 * 拼一个 cmd.exe 认得的参数。
 *
 * 只有含空白、引号或 cmd 元字符时才加引号。引号内交给目标程序的 C runtime 剥：引号前的
 * 反斜杠按 `2n` 个留 `n` 个、`2n+1` 个留 `n` 个再补一个字面引号，收尾的反斜杠翻倍才不会
 * 和收尾引号粘成转义。不能照搬 cmd 自己的 `""`——外层 `"${line}"` 被 `/s` 剥掉一层后，
 * 这段字符串原样进了 runtime 的 argv 解析。
 *
 * @param {string} argument - 原始参数
 * @returns {string} 可以直接拼进命令行的样子
 */
export function quoteForCmd(argument) {
  if (argument === '') return '""'
  if (!/[\s"&|<>^(),;=]/.test(argument)) return argument
  let text = '"'
  let backslashes = 0
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      text += `${'\\'.repeat(backslashes * 2 + 1)}"`
      backslashes = 0
      continue
    }
    text += `${'\\'.repeat(backslashes)}${character}`
    backslashes = 0
  }
  return `${text}${'\\'.repeat(backslashes * 2)}"`
}

/**
 * 拼出完整的命令行。
 *
 * `cmd.exe /c` 只认一整条字符串，Node 的 `shell: true` 在 Windows 上不逐个转义参数、
 * 还会报 DEP0190，所以自己拼。
 *
 * @param {object} options - 选项
 * @param {string} options.file - 可执行文件
 * @param {string[]} options.args - 参数
 * @returns {string} 命令行
 */
export function buildCommandLine({ file, args }) {
  return [file, ...args].map(quoteForCmd).join(' ')
}

/**
 * 起一条命令，同步等待结束。
 *
 * 其余选项原样传给 `spawnSync`（`cwd`、`encoding`、`stdio` 等）。
 *
 * @param {object} options - 选项
 * @param {string} options.command - 命令名或路径
 * @param {string[]} [options.args] - 参数
 * @param {string} [options.platform] - 平台，测试用
 * @param {object} [options.env] - 子进程环境变量，同时用于查 PATH
 * @param {(path: string) => boolean} [options.exists] - 文件存在性探测，测试用
 * @param {readonly string[]} [options.extensions] - 扩展名候选，测试用
 * @returns {import('node:child_process').SpawnSyncReturns<string | Buffer>} `spawnSync` 的结果
 */
export function spawnCommandSync({ command, args = [], platform = process.platform, env = process.env, exists = isFile, extensions = WINDOWS_EXTENSIONS, ...options }) {
  const spawnOptions = { env, ...options }
  if (platform !== 'win32') return checkSpawned(spawnSync(command, args, spawnOptions), command)

  const file = resolveExecutable({ command, pathValue: pathValueOf(env), exists, extensions })
  if (file === null) throw new CommandNotFoundError(command)
  // /d 跳过注册表里 AutoRun 的用户钩子，/s 固定引号处理规则：Node 的
  // `shell: true` 在 Windows 上就是把整条命令行加引号后 verbatim 交给 cmd，
  // 这里照做，参数才按自己拼的样子落地。
  const line = buildCommandLine({ file, args })
  const shell = cmdPath()
  const result = spawnSync(shell, ['/d', '/s', '/c', `"${line}"`], {
    windowsVerbatimArguments: true,
    ...spawnOptions,
  })
  // 命令已经解析成功，这里再失败只可能是 cmd 自己起不来——不能归成「找不到命令」。
  if (result.error !== undefined) throw new CommandShellError(shell, result.error)
  return checkSpawned(result, command)
}

/**
 * 把 `spawnSync` 的错误归一成异常。
 *
 * @param {object} result - `spawnSync` 的结果
 * @param {string} command - 原始命令，用于报错
 * @returns {object} 原结果
 */
function checkSpawned(result, command) {
  if (result.error?.code === 'ENOENT') throw new CommandNotFoundError(command)
  if (result.error !== undefined) throw result.error
  return result
}
