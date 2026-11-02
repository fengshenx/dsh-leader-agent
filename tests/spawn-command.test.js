import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CommandNotFoundError, CommandShellError, buildCommandLine, pathValueOf, quoteForCmd, resolveExecutable, spawnCommandSync,
} from '../scripts/spawn-command.mjs'
import { cleanupTempDirs, makeTempDir } from './helpers/temp-dir.js'

after(cleanupTempDirs)

const NPM_DIR = 'C:\\Users\\me\\AppData\\Roaming\\npm'
const NODE_DIR = 'C:\\Program Files\\nodejs'

/**
 * 造一个只认给定文件集合的存在性探测。
 * @param {string[]} files - 认为存在的路径
 * @returns {(path: string) => boolean} 探测函数
 */
function existsIn(files) {
  const known = new Set(files)
  return (path) => known.has(path)
}

test('PATH 上只有 .cmd shim 时解析到 .cmd，不选无扩展名的 sh 脚本', () => {
  const exists = existsIn([join(NPM_DIR, 'dsh'), join(NPM_DIR, 'dsh.cmd'), join(NPM_DIR, 'dsh.ps1')])
  assert.equal(resolveExecutable({ command: 'dsh', pathValue: NPM_DIR, exists }), join(NPM_DIR, 'dsh.cmd'))
})

test('同名文件有多个扩展名时按 PATHEXT 顺序优先 .exe', () => {
  const exists = existsIn([join(NODE_DIR, 'npm.cmd'), join(NODE_DIR, 'npm.exe')])
  assert.equal(resolveExecutable({ command: 'npm', pathValue: NODE_DIR, exists }), join(NODE_DIR, 'npm.exe'))
})

test('多个 PATH 目录按顺序找，命中先出现的那个', () => {
  const exists = existsIn([join(NODE_DIR, 'dsh.exe'), join(NPM_DIR, 'dsh.cmd')])
  const pathValue = `${NODE_DIR};${NPM_DIR}`
  assert.equal(resolveExecutable({ command: 'dsh', pathValue, exists }), join(NODE_DIR, 'dsh.exe'))
  assert.equal(resolveExecutable({ command: 'dsh', pathValue: `${NPM_DIR};${NODE_DIR}`, exists }), join(NPM_DIR, 'dsh.cmd'))
})

test('显式路径带扩展名时原样返回，不再补扩展名', () => {
  const command = join('C:\\tools', 'dsh.cmd')
  const exists = existsIn([command, join('C:\\tools', 'dsh.cmd.cmd')])
  assert.equal(resolveExecutable({ command, pathValue: NPM_DIR, exists }), command)
})

test('显式路径没有扩展名时补扩展名', () => {
  const exists = existsIn([join('C:\\tools', 'dsh.cmd')])
  assert.equal(resolveExecutable({ command: join('C:\\tools', 'dsh'), pathValue: '', exists }), join('C:\\tools', 'dsh.cmd'))
})

test('给了显式路径就不再去 PATH 上找同名命令', () => {
  const exists = existsIn([join(NPM_DIR, 'dsh.cmd')])
  assert.equal(resolveExecutable({ command: join('C:\\tools', 'dsh'), pathValue: NPM_DIR, exists }), null)
})

test('PATH 条目带引号也能命中', () => {
  const exists = existsIn([join(NODE_DIR, 'node.exe')])
  assert.equal(resolveExecutable({ command: 'node', pathValue: `"${NODE_DIR}"`, exists }), join(NODE_DIR, 'node.exe'))
})

test('跳过 PATH 里的空条目，找不到时返回 null', () => {
  const exists = existsIn([])
  assert.equal(resolveExecutable({ command: 'dsh', pathValue: `;${NPM_DIR};;`, exists }), null)
})

test('pathValueOf 认大写或小写的 PATH，两者都在时认精确的 PATH', () => {
  assert.equal(pathValueOf({ PATH: NPM_DIR }), NPM_DIR)
  assert.equal(pathValueOf({ Path: NPM_DIR }), NPM_DIR)
  assert.equal(pathValueOf({ Path: 'stale', PATH: NPM_DIR }), NPM_DIR)
  assert.equal(pathValueOf({ HOME: '/home/me' }), '')
})

test('PATH 上与命令同名的目录不算可执行文件，继续找下一个扩展名', async () => {
  const dir = await makeTempDir('dsh-leader-kit spawn dir-')
  mkdirSync(join(dir, 'probe-dir.exe'))
  assert.equal(resolveExecutable({ command: 'probe-dir', pathValue: dir }), null)
  writeFileSync(join(dir, 'probe-dir.cmd'), '@echo off\r\n')
  assert.equal(resolveExecutable({ command: 'probe-dir', pathValue: dir }), join(dir, 'probe-dir.cmd'))
})

test('quoteForCmd 只在需要时加引号', () => {
  assert.equal(quoteForCmd('--port'), '--port')
  assert.equal(quoteForCmd('a b'), '"a b"')
  assert.equal(quoteForCmd(''), '""')
})

test('quoteForCmd 给结尾反斜杠翻倍，别和收尾引号粘成转义', () => {
  assert.equal(quoteForCmd('C:\\my dir\\'), '"C:\\my dir\\\\"')
  assert.equal(quoteForCmd('a b\\\\'), `"a b${'\\'.repeat(4)}"`)
})

test('quoteForCmd 按 C runtime 规则处理引号前的反斜杠', () => {
  assert.equal(quoteForCmd('a\\"b'), `"a${'\\'.repeat(3)}"b"`)
  assert.equal(quoteForCmd('x\\\\"y'), `"x${'\\'.repeat(5)}"y"`)
})

test('quoteForCmd 不对 % 做处理：cmd 的变量展开拦不住（已知边界）', () => {
  assert.equal(quoteForCmd('%OS%'), '%OS%')
  assert.equal(quoteForCmd('a b %OS%'), '"a b %OS%"')
})

test('buildCommandLine 把可执行文件与参数拼成一条命令行', () => {
  assert.equal(
    buildCommandLine({ file: join(NODE_DIR, 'node.exe'), args: ['-e', 'console.log(1)'] }),
    `"${join(NODE_DIR, 'node.exe')}" -e "console.log(1)"`,
  )
})

test('spawnCommandSync 起一个真实进程并拿到输出', () => {
  // process.execPath 在 Windows 上落在 `C:\Program Files\…`，顺带验证带空格的路径
  const result = spawnCommandSync({ command: process.execPath, args: ['-p', '1 + 1'], encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), '2')
})

test('spawnCommandSync 找不到命令时抛 CommandNotFoundError', () => {
  assert.throws(
    () => spawnCommandSync({ command: 'dsh-leader-kit-definitely-missing', args: ['--version'], encoding: 'utf8' }),
    CommandNotFoundError,
  )
})

test('Windows 上经 cmd.exe 起带空格的 .cmd shim，参数原样到达', { skip: process.platform !== 'win32' }, async () => {
  const dir = await makeTempDir('dsh-leader-kit spawn space-')
  const shim = join(dir, 'probe-cmd.cmd')
  writeFileSync(shim, '@echo off\r\necho [%~1]\r\n')
  const result = spawnCommandSync({ command: shim, args: ['a b'], encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), '[a b]')
})

test('Windows 上按 PATH 解析出无扩展名命令的 .cmd shim 并起起来', { skip: process.platform !== 'win32' }, async () => {
  const dir = await makeTempDir('dsh-leader-kit spawn path-')
  writeFileSync(join(dir, 'probe-path.cmd'), '@echo off\r\necho resolved [%~1]\r\n')
  const result = spawnCommandSync({
    command: 'probe-path', args: ['ok'], encoding: 'utf8', env: { ...process.env, PATH: dir },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), 'resolved [ok]')
})

test('解析结果决定起哪个文件，而不是把命令名丢回 cmd 自己找', { skip: process.platform !== 'win32' }, async () => {
  const dir = await makeTempDir('dsh-leader-kit spawn pick-')
  writeFileSync(join(dir, 'probe-pick.cmd'), '@echo off\r\necho from-cmd\r\n')
  writeFileSync(join(dir, 'probe-pick.bat'), '@echo off\r\necho from-bat\r\n')
  // PATHEXT 里 .BAT 排在 .CMD 前面：只看 PATH 的话 cmd 会起 .bat，走解析则按
  // WINDOWS_EXTENSIONS 的顺序选 .cmd。两者结果不同，才能守住 file 有没有被用上。
  const result = spawnCommandSync({
    command: 'probe-pick', encoding: 'utf8',
    env: { ...process.env, PATH: dir, PATHEXT: '.BAT;.CMD' },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), 'from-cmd')
})

test('调用方收窄 env 时仍能起 cmd：cmd 的定位不依赖子进程环境', { skip: process.platform !== 'win32' }, async () => {
  const dir = await makeTempDir('dsh-leader-kit spawn env-')
  writeFileSync(join(dir, 'probe-env.cmd'), '@echo off\r\necho env-ok\r\n')
  const env = { ...process.env, PATH: dir }
  delete env.ComSpec
  const result = spawnCommandSync({ command: 'probe-env', encoding: 'utf8', env })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), 'env-ok')
})

test('cmd 自己起不来时抛 CommandShellError，不误报成命令找不到', { skip: process.platform !== 'win32' }, () => {
  const original = process.env.ComSpec
  process.env.ComSpec = join(tmpdir(), 'no-such-cmd.exe')
  try {
    assert.throws(
      () => spawnCommandSync({ command: 'cmd', encoding: 'utf8', env: { ...process.env } }),
      (error) => error instanceof CommandShellError && error.message.includes('起不了 Windows 命令解释器'),
    )
  } finally {
    if (original === undefined) delete process.env.ComSpec
    else process.env.ComSpec = original
  }
})

test('参数超过命令行上限时抛原始错误，不归成 CommandShellError', { skip: process.platform !== 'win32' }, () => {
  // 具体错误码（这里是 ENAMETOOLONG）是实现细节，用例守的是归类边界：与 cmd 无关的
  // 失败不能被包成「起不了 cmd」。
  assert.throws(
    () => spawnCommandSync({ command: process.execPath, args: ['-e', '', 'x'.repeat(33000)], encoding: 'utf8' }),
    (error) => !(error instanceof CommandShellError),
  )
})

test('参数里的 %VAR% 会被 cmd 展开，引号拦不住（已知边界）', { skip: process.platform !== 'win32' }, () => {
  const result = spawnCommandSync({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(String(process.argv[1]))', '--', '%DSH_PROBE_VAR%'],
    encoding: 'utf8',
    env: { ...process.env, DSH_PROBE_VAR: 'expanded' },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), 'expanded')
})
