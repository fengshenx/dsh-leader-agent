import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withFileLockSync, writeFileAtomicSync } from '../scripts/atomic-write.mjs'

/** 造一个临时目录，跑完删掉。 */
function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'atomic-write-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('原子写替换已有文件，权限收紧到 600', (t) => {
  withTempDir((root) => {
    const target = join(root, '.credentials.yaml')
    writeFileSync(target, 'old\n', { mode: 0o644 })
    writeFileAtomicSync(target, 'new\n', { mode: 0o600 })
    assert.equal(readFileSync(target, 'utf8'), 'new\n')
    // Windows 的 chmod 只影响只读位，0o600 这类 POSIX 权限位不可能成立；用诊断把
    // 跳过的断言打进报告，避免「绿了但少验了一件事」看不见。
    if (process.platform === 'win32') t.diagnostic('win32 没有 POSIX 权限位，跳过 mode 断言')
    else assert.equal(statSync(target).mode & 0o777, 0o600)
  })
})

test('目标不存在时按给定权限创建，父目录跟着建出来', (t) => {
  withTempDir((root) => {
    const target = join(root, 'nested', 'home', '.credentials.yaml')
    writeFileAtomicSync(target, 'secret\n', { mode: 0o600, dirMode: 0o700 })
    assert.equal(readFileSync(target, 'utf8'), 'secret\n')
    assert.equal(statSync(join(root, 'nested', 'home')).isDirectory(), true)
    if (process.platform === 'win32') t.diagnostic('win32 没有 POSIX 权限位，跳过 mode 断言')
    else assert.equal(statSync(target).mode & 0o777, 0o600)
  })
})

test('替换后目录里不留临时文件', () => {
  withTempDir((root) => {
    const target = join(root, '.credentials.yaml')
    writeFileAtomicSync(target, 'a\n', { mode: 0o600 })
    writeFileAtomicSync(target, 'b\n', { mode: 0o600 })
    assert.deepEqual(readdirSync(root), ['.credentials.yaml'])
  })
})

test('写失败时把临时文件清掉，目标保持原样', () => {
  withTempDir((root) => {
    const target = join(root, '.credentials.yaml')
    writeFileSync(target, 'keep\n', { mode: 0o600 })
    // 内容不是字符串/字节时 writeFileSync 抛错，模拟写入中断。
    assert.throws(() => writeFileAtomicSync(target, undefined, { mode: 0o600 }))
    assert.equal(readFileSync(target, 'utf8'), 'keep\n')
    assert.deepEqual(readdirSync(root), ['.credentials.yaml'])
  })
})

test('锁内的读-改-写独占目标：同进程重入会等到超时，文案先让人确认没有实例在跑', () => {
  withTempDir((root) => {
    const target = join(root, '.credentials.yaml')
    assert.throws(
      () => withFileLockSync(target, () => withFileLockSync(target, () => 'inner', { waitMs: 50 })),
      /等待写者锁超时.*先确认没有 dev 实例在跑/,
    )
  })
})

test('活锁的持有者没退出时不会被接管，等不到就超时报错', () => {
  withTempDir((root) => {
    const target = join(root, '.credentials.yaml')
    // 本进程之外的一个活进程持有锁：内容是真的活 PID，探活成功，不该删。
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' })
    holder.unref()
    try {
      writeFileSync(`${target}.lock`, `${holder.pid}\n`, { mode: 0o600 })
      assert.throws(() => withFileLockSync(target, () => 'ok', { waitMs: 60 }), /等待写者锁超时/)
      assert.equal(readFileSync(`${target}.lock`, 'utf8'), `${holder.pid}\n`)
    } finally {
      holder.kill()
    }
  })
})

test('operation 抛错时锁照样释放', () => {
  withTempDir((root) => {
    const target = join(root, '.credentials.yaml')
    assert.throws(() => withFileLockSync(target, () => { throw new Error('boom') }), /boom/)
    assert.equal(withFileLockSync(target, () => 'ok', { waitMs: 50 }), 'ok')
  })
})

test('持有者进程已退出时接管遗留的锁，不会一直等下去', () => {
  withTempDir((root) => {
    const target = join(root, '.credentials.yaml')
    // 一个已经退出的进程的 PID：锁内容是它，探活得到 ESRCH。
    const exited = spawnSync(process.execPath, ['-e', ''])
    writeFileSync(`${target}.lock`, `${exited.pid}\n`, { mode: 0o600 })
    assert.equal(withFileLockSync(target, () => 'ok', { waitMs: 100 }), 'ok')
    assert.equal(statSync(`${target}.lock`, { throwIfNoEntry: false }), undefined)
  })
})
