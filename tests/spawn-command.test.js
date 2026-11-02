import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CommandNotFoundError, buildCommandLine, pathValueOf, quoteForCmd, resolveExecutable, spawnCommandSync,
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

test('quoteForCmd 只在需要时加引号', () => {
  assert.equal(quoteForCmd('--port'), '--port')
  assert.equal(quoteForCmd('a b'), '"a b"')
  assert.equal(quoteForCmd(''), '""')
})

test('quoteForCmd 给结尾反斜杠补一个，别和收尾引号粘成转义', () => {
  assert.equal(quoteForCmd('C:\\my dir\\'), '"C:\\my dir\\\\"')
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
