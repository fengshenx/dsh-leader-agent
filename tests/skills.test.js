import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { SKILLS_DIR } from '../src/host/index.js'
import { createSkillProvider } from '../src/host/skills.js'

const bundleRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillsRoot = join(bundleRoot, SKILLS_DIR)

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
  const relativeLinks = links.filter(link => !link.startsWith('http'))
  assert.ok(relativeLinks.length > 0, '协议层应有相对链接')
  for (const link of relativeLinks) {
    const resolved = join(target.resourceBase.path, link.split('#')[0])
    const { access } = await import('node:fs/promises')
    await access(resolved)
  }
})

test('skillsRoot 不可读时返回空候选并告警', async () => {
  const warnings = []
  const provider = createSkillProvider({
    skillsRoot: join(bundleRoot, 'missing-skills'),
    providerName: 'dsh-leader-kit',
    logger: message => warnings.push(message),
  })
  assert.deepEqual(await provider.list(), [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /missing-skills/)
})

test('package.json 的 files 覆盖宿主读取的 skillsRoot', async () => {
  const manifest = JSON.parse(await readFile(join(bundleRoot, 'package.json'), 'utf8'))
  assert.ok(Array.isArray(manifest.files), 'package.json 应有 files 白名单')
  const skillsDir = relative(bundleRoot, skillsRoot).split(sep).join('/')
  const files = await listFiles(skillsRoot)
  assert.ok(files.length > 0, `${skillsDir} 下应能找到 skill 文件`)
  for (const file of files) {
    assert.ok(
      filesInclude(`${skillsDir}/${file}`, manifest.files),
      `package.json 的 files 漏了 ${skillsDir}/${file}：装机后该 skill 静默失效`,
    )
  }
})

/**
 * 递归列出目录下的文件，返回相对目录的 POSIX 路径。
 * @param {string} directory - 目录绝对路径
 * @param {string} [prefix] - 已累积的相对路径
 * @returns {Promise<string[]>} 相对文件路径
 */
async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), path))
    else files.push(path)
  }
  return files
}

/**
 * npm `files` 的收录语义（npm-packlist 常用子集的复刻）：`**` 跨目录、`*` 只在段内、
 * 整段目录名递归收录其下全部文件、`!` 前缀排除。不模拟 npm 的默认忽略清单——
 * `.agents` 不在其中（实测 `npm pack --dry-run` 含全部 skill 文件），这里守的是
 * `files` 自身是否覆盖 `skillsRoot`。
 * @param {string} path - 相对包根的 POSIX 路径
 * @param {string[]} patterns - `package.json` 的 `files`
 * @returns {boolean} 是否会被打进 tarball
 */
function filesInclude(path, patterns) {
  let included = false
  for (const raw of patterns) {
    const negated = raw.startsWith('!')
    const pattern = (negated ? raw.slice(1) : raw).replace(/^\.\//, '').replace(/\/+$/, '')
    if (matchesPath(path, pattern)) included = !negated
  }
  return included
}

/**
 * 判断文件路径是否命中单个 glob。
 * @param {string} path - 相对包根的 POSIX 路径
 * @param {string} pattern - glob 或目录名
 * @returns {boolean} 是否命中
 */
function matchesPath(path, pattern) {
  if (!/[*?]/.test(pattern)) return path === pattern || path.startsWith(`${pattern}/`)
  const pathSegments = path.split('/')
  const patternSegments = pattern.split('/')
  const matchesAt = (index, patternIndex) => {
    if (patternIndex === patternSegments.length) return index === pathSegments.length
    if (patternSegments[patternIndex] === '**') {
      for (let skip = index; skip <= pathSegments.length; skip += 1) {
        if (matchesAt(skip, patternIndex + 1)) return true
      }
      return false
    }
    if (index === pathSegments.length) return false
    if (!matchesSegment(patternSegments[patternIndex], pathSegments[index])) return false
    return matchesAt(index + 1, patternIndex + 1)
  }
  return matchesAt(0, 0)
}

/**
 * 判断单个路径段是否命中 glob 段（`*` / `?` 不跨 `/`）。
 * @param {string} pattern - glob 段
 * @param {string} segment - 路径段
 * @returns {boolean} 是否命中
 */
function matchesSegment(pattern, segment) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`).test(segment)
}
