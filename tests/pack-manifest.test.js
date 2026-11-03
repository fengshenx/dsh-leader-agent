import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { checkPackEntries, isForbiddenPath, requiredPackFiles } from '../scripts/pack-manifest.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

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
      files: ['dist/index.js', 'cordis.patch.yml'],
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

test('files 里的固定路径并进必需集，通配不展开', () => {
  const files = requiredPackFiles({
    manifest: { ...manifest, files: ['index.js', 'lib/client.js', 'README_ZH.md', 'src/**', '.agents/skills/**'] },
    skillFiles: [],
    localeFiles: [],
  })
  assert.ok(files.includes('README_ZH.md'), 'files 写了它就该验它在包里：文件改名时 npm 不报错，只是不带')
  assert.ok(!files.some((path) => path.includes('*')), `通配不该展开：${files.join(', ')}`)
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
    'LEADER.md',
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
    'LEADER.md',
    'SLOTS.md',
    'docs/architecture.md',
  ])
})

test('.agents 只放行 skills 子树：新增目录默认被拦', () => {
  // 这个目录同时住着要发布的 skill 与仓内上下文，所以按「只允许 skills 前缀」正向
  // 判定：哪天 files 写成 ".agents/**"，新目录也不会静默进用户的 node_modules。
  const forbidden = [
    '.agents/prompts/hidden.md',
    '.agents/notes/2026-11-02-npm-publish-pipeline.md',
    '.agents/README.md',
    '.agents/config.json',
    '.agents/skills-extra/leader-mode/SKILL.md',
  ]
  for (const path of forbidden) assert.equal(isForbiddenPath(path), true, `${path} 应被拦下`)

  const published = [
    '.agents/skills/leader-mode/SKILL.md',
    '.agents/skills/leader-mode/playbooks/delivery.md',
    '.agents/skills/init-project/references/conventions.md',
  ]
  for (const path of published) assert.equal(isForbiddenPath(path), false, `${path} 是发布文件`)
})

test('files 放宽到 .agents/** 时，notes 与新增目录仍被拦', () => {
  const entries = [
    'index.js',
    '.agents/skills/leader-mode/SKILL.md',
    '.agents/notes/2026-11-02-npm-publish-pipeline.md',
    '.agents/prompts/hidden.md',
  ]
  const { forbidden, missing } = checkPackEntries({ entries, required: [] })
  assert.deepEqual(forbidden, ['.agents/notes/2026-11-02-npm-publish-pipeline.md', '.agents/prompts/hidden.md'])
  assert.deepEqual(missing, [])
})

test('.telov 是工作区运维目录，整棵子树都不该进包', () => {
  // 今天靠 files 白名单兜住（.telov/ 不在名单里）；白名单哪天放宽，这里是第二道
  // 防线。发版 skill 只服务本仓维护者，装到用户 node_modules 里没有用处。
  const forbidden = [
    '.telov/skills/release/SKILL.md',
    '.telov/mcp.json',
  ]
  for (const path of forbidden) assert.equal(isForbiddenPath(path), true, `${path} 应被拦下`)

  const { forbidden: caught } = checkPackEntries({
    entries: ['index.js', '.telov/skills/release/SKILL.md'],
    required: [],
  })
  assert.deepEqual(caught, ['.telov/skills/release/SKILL.md'])
})

test('发布包要用的路径不被误判', () => {
  const legit = [
    'src/host/index.js',
    'src/shared/projects.js',
    'src/client/board.js',
    'locale/zh.json',
    '.agents/skills/leader-mode/playbooks/delivery.md',
    'lib/client.js',
    'cordis.patch.yml',
  ]
  for (const path of legit) assert.equal(isForbiddenPath(path), false, `${path} 不该被拦下`)
})
