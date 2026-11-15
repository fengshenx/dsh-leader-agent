/**
 * 宣传片技能脚本的 CLI 边界。
 *
 * 这两个脚本不在 `src` 的覆盖率分母里，但它们是用户直接调用的入口：未知参数、
 * 缺依赖、缺环境变量都必须大声失败，错误信息也不能把误传的密钥带出去。
 * 用子进程跑真实 CLI，不 import 脚本本身（模块顶层会直接执行 main）。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TTS = join(ROOT, '.agents/skills/doubao-tts/scripts/tts.mjs')
const RENDER = join(ROOT, '.agents/skills/promo-stills/scripts/render.mjs')

/**
 * 跑一次脚本；清掉本机可能存在的豆包密钥，保证缺变量用例可重复。
 *
 * @param {string} script - 脚本绝对路径
 * @param {string[]} args - 命令行参数
 * @param {{ cwd?: string, env?: Record<string, string> }} [options] - 额外选项
 * @returns {import('node:child_process').SpawnSyncReturns<string>} 子进程结果
 */
function runScript(script, args, { cwd = ROOT, env = {} } = {}) {
  const base = { ...process.env }
  delete base.DOUBAO_TTS_KEY
  delete base.DOUBAO_TTS_API_KEY
  delete base.NODE_PATH
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...base, ...env },
    timeout: 30_000,
  })
}

/** 造一个临时目录，跑完删掉。 */
function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'promo-scripts-'))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('render.mjs：未知长参数直接失败并列出可用参数', () => {
  const result = runScript(RENDER, ['--widht', '1920', '--url', 'cover.html', '--out', 'cover.png'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /未知参数：--widht/)
  assert.match(result.stderr, /可用参数：.*--width/)
  assert.doesNotMatch(result.stdout, /已导出/)
})

test('tts.mjs：未知长参数直接失败并列出可用参数', () => {
  const result = runScript(TTS, ['--text', '你好', '--out', 'voice.mp3', '--speeker', 'zh_female_vv_uranus_bigtts'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /未知参数：--speeker/)
  assert.match(result.stderr, /可用参数：.*--speaker/)
})

test('tts.mjs：缺 DOUBAO_TTS_KEY 时退出并提示变量名，不写文件', () => {
  withTempDir((root) => {
    const out = join(root, 'voice.mp3')
    const result = runScript(TTS, ['--text', '你好', '--out', out])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /DOUBAO_TTS_KEY/)
    assert.equal(existsSync(out), false)
  })
})

test('两个脚本：位置参数不回显原始值', () => {
  const secret = 'sk-test-should-not-leak'
  for (const script of [TTS, RENDER]) {
    const result = runScript(script, [secret])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /位置参数/)
    assert.doesNotMatch(result.stderr, new RegExp(secret))
  }
})

test('tts.mjs：--endpoint 只接受 http(s)，错误里不带 Key', () => {
  const result = runScript(
    TTS,
    ['--text', '你好', '--out', 'voice.mp3', '--endpoint', 'file:///tmp/tts'],
    { env: { DOUBAO_TTS_KEY: 'test-key-not-real' } },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /只支持 http\(s\)/)
  assert.doesNotMatch(result.stderr, /test-key-not-real/)
})


test('tts.mjs：非法数值选项不回显原值', () => {
  const secret = 'sk-test-rate-value'
  const result = runScript(
    TTS,
    ['--text', '你好', '--out', 'voice.mp3', '--rate', secret],
    { env: { DOUBAO_TTS_KEY: 'test-key-not-real' } },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--rate 必须是 -50\.\.100 的整数/)
  assert.doesNotMatch(result.stderr, new RegExp(secret))
})

test('render.mjs：缺 playwright 时打印安装指引，而不是裸 ERR_MODULE_NOT_FOUND', () => {
  withTempDir((root) => {
    const script = join(root, 'render.mjs')
    copyFileSync(RENDER, script)
    const result = runScript(script, ['--url', join(root, 'cover.html'), '--out', join(root, 'cover.png')], { cwd: root })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /缺少依赖 playwright/)
    assert.match(result.stderr, /npm i -D playwright/)
    assert.match(result.stderr, /npx playwright install chromium/)
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/)
    assert.equal(existsSync(join(root, 'cover.png')), false)
  })
})

test('render.mjs：--help 在缺 playwright 的环境里也能用', () => {
  withTempDir((root) => {
    const script = join(root, 'render.mjs')
    copyFileSync(RENDER, script)
    const result = runScript(script, ['--help'], { cwd: root })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /HTML → PNG 封面渲染/)
  })
})
