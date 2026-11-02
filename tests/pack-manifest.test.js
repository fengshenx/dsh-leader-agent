import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { FORBIDDEN_PATTERNS, checkPackEntries, requiredPackFiles } from '../scripts/pack-manifest.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * 只取某一条规则命中的路径，便于按规则断言。
 * @param {RegExp} pattern - 规则
 * @param {string[]} paths - 候选路径
 * @returns {string[]} 命中路径
 */
function matched(pattern, paths) {
  return paths.filter((path) => pattern.test(path))
}

test('必需文件从 main、exports 与 dsh.bundle.patch 推导，不抄第二份清单', () => {
  const files = requiredPackFiles({ manifest, skillFiles: [], localeFiles: [] })
  for (const path of ['index.js', 'package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', 'src/host/index.js', 'lib/client.js']) {
    assert.ok(files.includes(path), `必需文件应含 ${path}`)
  }
})

test('改入口即改门禁：manifest 里的路径直接决定必需文件', () => {
  const files = requiredPackFiles({
    manifest: {
      ...manifest,
      main: 'dist/index.js',
      exports: { ...manifest.exports, '.': './dist/index.js' },
      dsh: { bundle: { patch: './other.patch.yml' } },
    },
    skillFiles: [],
    localeFiles: [],
  })
  assert.ok(files.includes('dist/index.js'))
  assert.ok(files.includes('other.patch.yml'))
  assert.ok(!files.includes('index.js'), '旧的 main 不该继续留着')
})

test('exports 的通配子路径不作为必需文件，覆盖面交给磁盘枚举', () => {
  const files = requiredPackFiles({ manifest, skillFiles: [], localeFiles: [] })
  assert.ok(!files.some((path) => path.includes('*')), `通配不该进必需集：${files.join(', ')}`)
  assert.ok(!files.includes('locale/zh.json'), 'locale 由调用方枚举，不靠通配推导')
})

test('skill 与 locale 的文件逐个并入必需集，并规整成包内路径', () => {
  const files = requiredPackFiles({
    manifest,
    skillFiles: ['.agents/skills/leader-mode/SKILL.md', './.agents/skills/init-project/SKILL.md'],
    localeFiles: ['zh.json', 'en.json'],
  })
  assert.ok(files.includes('.agents/skills/leader-mode/SKILL.md'))
  assert.ok(files.includes('.agents/skills/init-project/SKILL.md'))
  assert.ok(files.includes('locale/zh.json'))
  assert.ok(files.includes('locale/en.json'))
})

test('缺件按路径逐个报出', () => {
  const { missing, forbidden } = checkPackEntries({
    entries: ['index.js', 'package.json'],
    required: ['index.js', 'package.json', 'lib/client.js', '.agents/skills/leader-mode/SKILL.md'],
  })
  assert.deepEqual(missing, ['lib/client.js', '.agents/skills/leader-mode/SKILL.md'])
  assert.deepEqual(forbidden, [])
})

test('开发残留进包会被拦下', () => {
  const entries = [
    'index.js',
    'tests/skills.test.js',
    '.agents/notes/2026-11-02-npm-publish-pipeline.md',
    '.agents/skills/leader-mode/SKILL.md',
    'scripts/verify-pack.mjs',
    '.dev/home/sessions/x.json',
    'dsh-leader-kit-0.1.0.tgz',
  ]
  const { forbidden } = checkPackEntries({ entries, required: [] })
  assert.deepEqual(forbidden.sort(), [
    '.agents/notes/2026-11-02-npm-publish-pipeline.md',
    '.dev/home/sessions/x.json',
    'dsh-leader-kit-0.1.0.tgz',
    'scripts/verify-pack.mjs',
    'tests/skills.test.js',
  ])
})

test('files 放宽后，仓内文档与决策笔记仍进不了包', () => {
  // 这些文件当前不在 files 白名单里，黑名单是白名单被改成 "docs/**" 或 "*.md" 时的兜底。
  const entries = [
    'index.js',
    'AGENTS.md',
    'CLAUDE.md',
    'SLOTS.md',
    'COORDINATOR.md',
    '.agents/README.md',
    'docs/architecture.md',
  ]
  const { forbidden } = checkPackEntries({ entries, required: [] })
  assert.deepEqual(forbidden.sort(), [
    '.agents/README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'COORDINATOR.md',
    'SLOTS.md',
    'docs/architecture.md',
  ])
})

test('发布包要用的目录不被误判', () => {
  const legit = [
    'src/host/index.js',
    'src/client/board.js',
    'locale/zh.json',
    '.agents/skills/leader-mode/playbooks/delivery.md',
    'lib/client.js',
  ]
  for (const pattern of FORBIDDEN_PATTERNS) {
    assert.deepEqual(matched(pattern, legit), [], `规则 ${pattern} 误伤了发布文件`)
  }
})
