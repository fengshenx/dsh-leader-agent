import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'third-party-license.mjs')
const TARGET = join(ROOT, 'THIRD_PARTY_LICENSE')

/**
 * 跑一次生成脚本。
 * @param {...string} args - 参数
 * @returns {object} spawnSync 结果
 */
function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
}

test('THIRD_PARTY_LICENSE 与生成脚本同步', () => {
  const result = run('--check')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /校验通过/)
})

test('许可清单列出内联依赖、参考实现与工具', () => {
  const text = readFileSync(TARGET, 'utf8')
  assert.match(text, /blobatar 2\.7\.0（MIT）/)
  assert.match(text, /dsh-session-tabs 0\.1\.6（MIT）/)
  assert.match(text, /Copyright \(c\) 2026 QIN-SMART/)
  assert.match(text, /Copyright \(c\) 2026 Alain/)
  assert.match(text, /\| esbuild \|/)
  assert.match(text, /\| playwright \|/)
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('THIRD_PARTY_LICENSE'), 'THIRD_PARTY_LICENSE 应当进 npm 包')
})

test('未知参数按失败处理', () => {
  const result = run('--nope')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /未知参数/)
})
