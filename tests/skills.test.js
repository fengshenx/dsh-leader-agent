import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createSkillProvider } from '../src/host/skills.js'

const bundleRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillsRoot = join(bundleRoot, '.agents', 'skills')

test('发现 bundle 内全部 skill', async () => {
  const provider = createSkillProvider({ skillsRoot, providerName: 'dsh-leader-kit' })
  const candidates = await provider.list()
  const names = candidates.map(candidate => candidate.name).sort()
  assert.deepEqual(names, ['init-project', 'leader-mode'])
})

test('候选带可加载的正文与目录资源基址', async () => {
  const provider = createSkillProvider({ skillsRoot, providerName: 'dsh-leader-kit' })
  const candidates = await provider.list()
  const target = candidates.find(candidate => candidate.name === 'leader-mode')
  assert.ok(target, 'leader-mode 应被发现')
  assert.equal(target.source, 'bundled')
  assert.equal(target.provider, 'dsh-leader-kit')
  assert.equal(target.resourceBase.kind, 'directory')

  const definition = await provider.get(target)
  assert.ok(definition)
  assert.match(definition.content, /编排 playbook/)
  assert.doesNotMatch(definition.content, /^\s*---\s*$/m)
})

test('未知候选返回 undefined', async () => {
  const provider = createSkillProvider({ skillsRoot, providerName: 'dsh-leader-kit' })
  const definition = await provider.get({ locator: { directory: '/nonexistent' } })
  assert.equal(definition, undefined)
})

test('协议层引用的是 bundle 内的相对路径', async () => {
  const provider = createSkillProvider({ skillsRoot, providerName: 'dsh-leader-kit' })
  const candidates = await provider.list()
  const target = candidates.find(candidate => candidate.name === 'leader-mode')
  const definition = await provider.get(target)
  const links = [...definition.content.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1])
  const relative = links.filter(link => !link.startsWith('http'))
  assert.ok(relative.length > 0, '协议层应有相对链接')
  for (const link of relative) {
    const resolved = join(target.resourceBase.path, link.split('#')[0])
    const { access } = await import('node:fs/promises')
    await access(resolved)
  }
})
