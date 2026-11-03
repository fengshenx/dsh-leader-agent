import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { test } from 'node:test'
import { expandHomePath, resolveDshHome, resolveHomeFromEnv } from '../src/host/home-paths.js'

// 家目录必须是本平台的绝对路径：Windows 上 POSIX 写法的 /home/user 是相对路径。
const HOME = resolve('/home/user')

test('未设、空串与纯空白的 DSH_HOME 都回落到宿主默认根 <家目录>/.dsh', () => {
  const expected = join(HOME, '.dsh')
  assert.equal(resolveDshHome({}, () => HOME), expected)
  assert.equal(resolveDshHome({ DSH_HOME: undefined }, () => HOME), expected)
  assert.equal(resolveDshHome({ DSH_HOME: '' }, () => HOME), expected)
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }, () => HOME), expected)
  // 非字符串（手写的假 env）按未设处理，不去调 trim。
  assert.equal(resolveDshHome({ DSH_HOME: 42 }, () => HOME), expected)
  // env 只用来读 DSH_HOME：env.HOME 不参与默认家目录，家目录一律交给解析器。
  assert.equal(resolveDshHome({ HOME: '/fake' }, () => HOME), expected)
})

test('进程环境没有 HOME 时回落到 os.homedir()', (t) => {
  // #97 的回归守卫，随 rebase 从 notification-store.test.js 搬到这里（解析实现换了位置）。
  // 显式删掉 HOME：Linux CI 上 HOME 与 os.homedir() 恰好相同，不删的话「回退到
  // process.env.HOME」也能通过，守不住 #97 修的 Windows 桌面端崩溃。
  const saved = process.env.HOME
  delete process.env.HOME
  t.after(() => {
    if (saved !== undefined) process.env.HOME = saved
  })
  assert.equal(resolveDshHome({}), join(homedir(), '.dsh'))
})

test('归一只对 DSH_HOME 有值分支生效，默认根由调用方给', () => {
  // 开发实例的数据根默认在工作树内，不在家目录下。
  const fallback = () => join(HOME, 'worktree', '.dev', 'home')
  assert.equal(resolveHomeFromEnv(undefined, fallback, () => HOME), fallback())
  assert.equal(resolveHomeFromEnv('', fallback, () => HOME), fallback())
  assert.equal(resolveHomeFromEnv('   ', fallback, () => HOME), fallback())
  assert.equal(resolveHomeFromEnv('/custom/dsh/', fallback, () => HOME), resolve('/custom/dsh'))
  assert.equal(resolveHomeFromEnv('~/dsh', fallback, () => HOME), join(HOME, 'dsh'))
  // 有值时完全走宿主口径，与 fallback 无关。
  assert.equal(resolveHomeFromEnv('rel/dsh', fallback, () => HOME), resolve('rel/dsh'))
})

test('DSH_HOME 优先于家目录，并归一化成绝对路径', () => {
  const expected = resolve('/custom/dsh')
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/dsh' }, () => HOME), expected)
  // 末尾分隔符与 . / .. 在归一化时消掉，宿主也是同一个结果。
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/dsh/' }, () => HOME), expected)
  assert.notEqual(resolveDshHome({ DSH_HOME: '/custom/dsh/' }, () => HOME), '/custom/dsh/')
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/./dsh/../dsh' }, () => HOME), expected)
  // 相对路径以进程 cwd 为基准，宿主同样 resolve 到绝对路径。
  assert.equal(resolveDshHome({ DSH_HOME: 'rel/dsh' }, () => HOME), resolve('rel/dsh'))
  assert.ok(isAbsolute(resolveDshHome({ DSH_HOME: 'rel/dsh' }, () => HOME)))
})

test('DSH_HOME 的 ~、~/ 与 ~\\ 前缀按家目录展开', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '~' }, () => HOME), HOME)
  assert.equal(resolveDshHome({ DSH_HOME: '~/dsh' }, () => HOME), join(HOME, 'dsh'))
  // Windows 上两种分隔符都有人写。
  assert.equal(resolveDshHome({ DSH_HOME: '~\\dsh' }, () => HOME), join(HOME, 'dsh'))
  // 展开后仍要归一化：~//dsh 与 ~/dsh 同一条路径。
  assert.equal(resolveDshHome({ DSH_HOME: '~//dsh' }, () => HOME), join(HOME, 'dsh'))
})

test('只展开开头的 ~：~user 写法与路径中间的 ~ 都不展开', () => {
  // 宿主不认 ~user，照普通相对路径解析到 <cwd>/~user/dsh。
  assert.equal(resolveDshHome({ DSH_HOME: '~user/dsh' }, () => HOME), resolve('~user/dsh'))
  assert.equal(expandHomePath('/work/~x', HOME), resolve('/work/~x'))
})

test('带首尾空白的 DSH_HOME 不 trim 取值，与宿主同一条路径', () => {
  // 宿主只用 trim 判空、取值用原值：这里是相对路径，基准是 cwd。
  const padded = resolveDshHome({ DSH_HOME: '  /custom/dsh  ' }, () => HOME)
  assert.equal(padded, resolve('  /custom/dsh  '))
  assert.notEqual(padded, resolve('/custom/dsh'))
})

test('盘符路径按平台 path 语义解析（与宿主同一个 resolve 调用）', () => {
  // Windows 上 C:\custom\dsh 是绝对路径；POSIX 上它是个含反斜杠的相对路径。
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\custom\\dsh' }, () => HOME), resolve('C:\\custom\\dsh'))
})

test('expandHomePath 的绝对路径原样归一化，相对路径按传入的基准目录', () => {
  const cwd = process.cwd()
  assert.equal(expandHomePath('/custom/dsh', HOME), resolve(cwd, '/custom/dsh'))
  assert.equal(expandHomePath('rel/home', HOME), resolve(cwd, 'rel/home'))
  assert.equal(expandHomePath('~/data', HOME), join(HOME, 'data'))
  assert.equal(expandHomePath('~', HOME), HOME)
})
