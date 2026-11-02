import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LEADER_KIT_PACKAGE, WEB_APP_BUNDLE, assertLeaderKitBundle, assertSeparateHome, assertWebBundle,
  corruptProfilePackageMessage, credentialRefBlocks, deriveProfilePackage, devWebBundleHint, mergeCredentialRefs,
  planNodeModules, resolveDevPaths, startWebBundleHint,
} from '../scripts/dev-plan.mjs'

const WORKTREE = '/work/repo/.worktrees/feature-a'
const SOURCE_HOME = '/home/user/.dsh'

/** 造一份源 profile 的 package.json。 */
function sourcePackage() {
  return {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh-experimental-agent-team-profile': '0.2.1-rc.2',
      'dsh-remind': 'link:/home/user/code/dsh-remind',
      'dsh-leader-kit': 'link:/home/user/code/dsh-leader-kit',
    },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remind', 'dsh-leader-kit'],
      },
    },
  }
}

test('默认数据根落在工作树内，源 HOME 取 ~/.dsh', () => {
  const paths = resolveDevPaths({ worktree: WORKTREE, homeDir: '/home/user', env: {} })
  assert.equal(paths.home, join(WORKTREE, '.dev', 'home'))
  assert.equal(paths.sourceProfileDir, join(SOURCE_HOME, 'profiles', 'web'))
  assert.equal(paths.sourceNodeModules, join(SOURCE_HOME, 'profiles', 'web', 'node_modules'))
  assert.equal(paths.profileDir, join(WORKTREE, '.dev', 'home', 'profiles', 'web'))
  assert.equal(paths.credentialsPath, join(WORKTREE, '.dev', 'home', '.credentials.yaml'))
  assert.equal(paths.sourceCredentialsPath, join(SOURCE_HOME, '.credentials.yaml'))
})

test('DSH_HOME 与 DSH_HOME_SOURCE 都能覆盖', () => {
  const paths = resolveDevPaths({
    worktree: WORKTREE,
    homeDir: '/home/user',
    env: { DSH_HOME: '/tmp/dev-home', DSH_HOME_SOURCE: '/tmp/origin-home' },
  })
  assert.equal(paths.home, '/tmp/dev-home')
  assert.equal(paths.profileDir, '/tmp/dev-home/profiles/web')
  assert.equal(paths.sourceHome, '/tmp/origin-home')
})

test('派生 package.json 把插件依赖换成工作树链接，其余依赖照抄', () => {
  const derived = deriveProfilePackage(sourcePackage(), WORKTREE)
  assert.equal(derived.dependencies[LEADER_KIT_PACKAGE], `link:${WORKTREE}`)
  assert.equal(derived.dependencies['dsh-remind'], 'link:/home/user/code/dsh-remind')
  assert.equal(derived.dependencies['@deepseek-ai/dsh-experimental-agent-team-profile'], '0.2.1-rc.2')
})

test('派生 package.json 不改入参', () => {
  const source = sourcePackage()
  deriveProfilePackage(source, WORKTREE)
  assert.equal(source.dependencies[LEADER_KIT_PACKAGE], 'link:/home/user/code/dsh-leader-kit')
  assert.deepEqual(source.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remind', 'dsh-leader-kit',
  ])
})

test('源 profile 没装本插件时，bundle 列表补上它', () => {
  const source = sourcePackage()
  source.dependencies = { 'dsh-remind': 'link:/home/user/code/dsh-remind' }
  source.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remind']
  const derived = deriveProfilePackage(source, WORKTREE)
  assert.deepEqual(derived.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remind', LEADER_KIT_PACKAGE,
  ])
  assert.equal(derived.dependencies[LEADER_KIT_PACKAGE], `link:${WORKTREE}`)
})

test('bundle 列表已有本插件时不重复追加', () => {
  const derived = deriveProfilePackage(sourcePackage(), WORKTREE)
  assert.equal(derived.dsh.profile.bundles.filter((name) => name === LEADER_KIT_PACKAGE).length, 1)
})

test('源 package.json 缺 dsh 段时也能派生', () => {
  const derived = deriveProfilePackage({ dependencies: {} }, WORKTREE)
  assert.deepEqual(derived.dsh.profile.bundles, [LEADER_KIT_PACKAGE])
  assert.equal(derived.dependencies[LEADER_KIT_PACKAGE], `link:${WORKTREE}`)
})

test('node_modules 逐条链到源，只有插件本体指工作树', () => {
  const plan = planNodeModules({
    sourceEntries: ['@deepseek-ai', 'dsh-leader-kit', 'dsh-remind', '.pnpm'],
    existingEntries: [],
    sourceNodeModules: '/home/user/.dsh/profiles/web/node_modules',
    worktree: WORKTREE,
  })
  const byName = Object.fromEntries(plan.links.map((item) => [item.name, item.target]))
  assert.equal(byName['@deepseek-ai'], '/home/user/.dsh/profiles/web/node_modules/@deepseek-ai')
  assert.equal(byName['.pnpm'], '/home/user/.dsh/profiles/web/node_modules/.pnpm')
  assert.equal(byName[LEADER_KIT_PACKAGE], WORKTREE)
  assert.deepEqual(plan.removals, [])
})

test('目标里多出来的条目要清掉，但插件本体不动', () => {
  const plan = planNodeModules({
    sourceEntries: ['@deepseek-ai'],
    existingEntries: ['@deepseek-ai', 'dsh-leader-kit', 'stale-plugin'],
    sourceNodeModules: '/src/node_modules',
    worktree: WORKTREE,
  })
  assert.deepEqual(plan.removals, ['stale-plugin'])
  assert.equal(plan.links.length, 2)
})

test('DSH_PROFILE 覆盖源 profile 名，两边的目录都跟着换', () => {
  const paths = resolveDevPaths({
    worktree: WORKTREE,
    homeDir: '/home/user',
    env: { DSH_PROFILE: 'sdk', DSH_HOME: '/tmp/dev-home' },
  })
  assert.equal(paths.profile, 'sdk')
  assert.equal(paths.sourceProfileDir, join(SOURCE_HOME, 'profiles', 'sdk'))
  assert.equal(paths.profileDir, '/tmp/dev-home/profiles/sdk')
})

test('DSH_PROFILE 传空串时落回 web', () => {
  assert.equal(resolveDevPaths({ worktree: WORKTREE, homeDir: '/home/user', env: { DSH_PROFILE: '' } }).profile, 'web')
})

test('数据根与源 HOME 相同时拒绝，两处 profile 目录也不例外', () => {
  assert.throws(
    () => assertSeparateHome({ home: '/home/user/.dsh', sourceHome: '/home/user/.dsh' }),
    /数据根与源 HOME 是同一个目录/,
  )
})

test('数据根与源 HOME 不同时放行', () => {
  assert.doesNotThrow(() => assertSeparateHome({
    home: join(WORKTREE, '.dev', 'home'),
    sourceHome: SOURCE_HOME,
  }))
})

test('绕路的写法（.. 与斜杠）仍判定为同一个目录', () => {
  assert.throws(
    () => assertSeparateHome({ home: '/home/user/.dsh/', sourceHome: '/home/user/sub/../.dsh' }),
    /数据根与源 HOME 是同一个目录/,
  )
})

test('符号链接指向源 HOME 时也拒绝', { skip: process.platform === 'win32' ? '需要创建符号链接权限' : false }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-plan-'))
  try {
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    assert.throws(
      () => assertSeparateHome({ home: join(root, 'alias'), sourceHome: join(root, 'real') }),
      /数据根与源 HOME 是同一个目录/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('两边都不存在时按字面量比较，不会误判', () => {
  assert.doesNotThrow(() => assertSeparateHome({ home: '/nowhere/a', sourceHome: '/nowhere/b' }))
  assert.throws(() => assertSeparateHome({ home: '/nowhere/a', sourceHome: '/nowhere/a' }), /同一个目录/)
})

test('profile 带 web app bundle 时放行', () => {
  assert.doesNotThrow(() => assertWebBundle({
    profileDir: '/home/user/.dsh/profiles/web',
    bundles: ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, LEADER_KIT_PACKAGE],
    hint: '不用改。',
  }))
})

test('profile 缺 web app bundle 时拒绝，并说清 dsh web 会静默空转', () => {
  assert.throws(
    () => assertWebBundle({
      profileDir: '/home/user/.dsh/profiles/dev',
      bundles: ['@deepseek-ai/dsh-base'],
      hint: '不用改。',
    }),
    /没有 @deepseek-ai\/dsh-web-app.*dsh web 起不来/s,
  )
})

test('profile 根本没写 bundles 时也拒绝', () => {
  assert.throws(
    () => assertWebBundle({ profileDir: '/x', bundles: undefined, hint: '不用改。' }),
    /dsh-web-app/,
  )
})

test('拒绝时用调用方给的修复建议，不串别处的开关', () => {
  assert.throws(
    () => assertWebBundle({
      profileDir: '/home/user/.dsh/profiles/web',
      bundles: [],
      hint: '删掉该 profile 让 dsh 按 web 模板重建。',
    }),
    (error) => error.message.includes('删掉该 profile') && !error.message.includes('DSH_PROFILE'),
  )
})

test('dev 的修复建议指向可换的 DSH_PROFILE', () => {
  assert.match(devWebBundleHint(), /DSH_PROFILE/)
})

test('start 的修复建议不提 DSH_PROFILE，给的是固定 profile 能照做的命令', () => {
  const hint = startWebBundleHint({
    profileDir: '/home/user/.dsh/profiles/web',
    dshCommand: 'dsh',
    worktree: WORKTREE,
  })
  assert.ok(!hint.includes('DSH_PROFILE'), 'start 的 profile 名固定，换 profile 的建议对它无效')
  assert.match(hint, /删掉 \/home\/user\/\.dsh\/profiles\/web/)
  assert.match(hint, /dsh plugin --profile web add \/work\/repo\/\.worktrees\/feature-a/)
})

test('profile package.json 损坏时给的是先修文件或删目录重建，不是直接重装', () => {
  const message = corruptProfilePackageMessage({
    packagePath: '/home/user/.dsh/profiles/web/package.json',
    parseMessage: "Expected ',' or '}' after property value in JSON at position 1",
    dshCommand: 'dsh',
    worktree: WORKTREE,
  })
  // dsh plugin 在该目录里跑 pnpm，pnpm 同样读这份文件，坏了照样失败。
  assert.match(message, /不是合法 JSON（Expected ',' or '}'/)
  assert.match(message, /先手工修好它/)
  assert.match(message, /删掉 \/home\/user\/\.dsh\/profiles\/web 让 dsh 按 web 模板重建/)
  assert.match(message, /删前确认里面没有别的插件/)
  assert.match(message, /dsh plugin --profile web add \/work\/repo\/\.worktrees\/feature-a/)
  assert.ok(!/重装一次/.test(message), '重装修不好损坏的 package.json')
})

test('漏传修复建议时直接报错，不拼出 undefined', () => {
  assert.throws(
    () => assertWebBundle({ profileDir: '/x', bundles: [] }),
    /需要 hint/,
  )
})

test('日常 profile 已装本插件时放行', () => {
  assert.doesNotThrow(() => assertLeaderKitBundle({
    profileDir: '/home/user/.dsh/profiles/web',
    bundles: ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE, LEADER_KIT_PACKAGE],
    worktree: WORKTREE,
  }))
})

test('日常 profile 没装本插件时拒绝，并给出可复制的安装命令', () => {
  assert.throws(
    () => assertLeaderKitBundle({
      profileDir: '/home/user/.dsh/profiles/web',
      bundles: ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE],
      worktree: WORKTREE,
    }),
    /没有 dsh-leader-kit.*dsh plugin --profile web add \/work\/repo\/\.worktrees\/feature-a/s,
  )
})

test('日常 profile 没写 bundles 时也拒绝', () => {
  assert.throws(
    () => assertLeaderKitBundle({ profileDir: '/x', bundles: undefined, worktree: WORKTREE }),
    /dsh-leader-kit/,
  )
})

const SOURCE_CREDENTIALS = [
  'version: 1',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-source',
  'records:',
  '  deepseek-account-platform/default:',
  '    kind: grant',
  '',
].join('\n')

test('凭据 refs 按键名取块，多行值原样保留', () => {
  const blocks = credentialRefBlocks([
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-a',
    '  MULTI_LINE: |-',
    '    line one',
    '    line two',
    'records:',
    '  owner/id:',
    '    kind: grant',
    '',
  ].join('\n'))
  assert.deepEqual([...blocks.keys()], ['DEEPSEEK_API_KEY', 'MULTI_LINE'])
  assert.deepEqual(blocks.get('MULTI_LINE'), ['  MULTI_LINE: |-', '    line one', '    line two'])
})

test('凭据 refs 节前的顶层注释不影响取块', () => {
  const blocks = credentialRefBlocks([
    'version: 1',
    '# 这一行是顶层注释',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-a',
    '',
  ].join('\n'))
  assert.deepEqual([...blocks.keys()], ['DEEPSEEK_API_KEY'])
})

test('开发实例还没有凭据文件时，写出一份只含 refs 的文档', () => {
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: null })
  assert.deepEqual(merged.keys, ['DEEPSEEK_API_KEY'])
  assert.equal(merged.text, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-source\n')
})

test('目标只有 records 时在末尾补 refs，records 原样保留', () => {
  const target = [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '',
  ].join('\n')
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: target })
  assert.match(merged.text, /client-connection\/browser-session:\n {4}kind: grant/)
  assert.match(merged.text, /refs:\n {2}DEEPSEEK_API_KEY: sk-source\n$/)
})

test('目标已有 refs 节但缺键时插到该节末尾，不碰后面的 records', () => {
  const target = [
    'version: 1',
    'refs:',
    '  OPENAI_API_KEY: sk-other',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '',
  ].join('\n')
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: target })
  assert.equal(merged.text, [
    'version: 1',
    'refs:',
    '  OPENAI_API_KEY: sk-other',
    '  DEEPSEEK_API_KEY: sk-source',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '',
  ].join('\n'))
})

test('目标已有同名键时不动——实例里保存过的值优先', () => {
  const target = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-edited-in-instance\n'
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: target })
  assert.equal(merged.text, null)
  assert.deepEqual(merged.keys, [])
})

test('源凭据没有 refs 时不做任何改动', () => {
  const merged = mergeCredentialRefs({ sourceText: 'version: 1\nrecords: {}\n', targetText: null })
  assert.equal(merged.text, null)
  assert.deepEqual(merged.keys, [])
})

test('目标文件为空时按不存在处理，写出完整文档', () => {
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: '' })
  assert.equal(merged.text, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-source\n')
})

test('目标文件末尾没有换行时补上换行再加 refs', () => {
  const merged = mergeCredentialRefs({
    sourceText: SOURCE_CREDENTIALS,
    targetText: 'version: 1\nrecords:\n  owner/id:\n    kind: grant',
  })
  assert.match(merged.text, /kind: grant\nrefs:\n {2}DEEPSEEK_API_KEY: sk-source\n$/)
})

test('目标 refs 是行内空映射（宿主删掉最后一个引用后的形态）时替换成块式，不出现第二个 refs', () => {
  const target = [
    'version: 1',
    'refs: {}',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '',
  ].join('\n')
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: target })
  assert.equal(merged.text, [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-source',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '',
  ].join('\n'))
  assert.equal(merged.text.match(/^refs:/gm).length, 1)
})

test('目标 refs 条目的缩进是四格时新条目也缩进四格', () => {
  const target = [
    'version: 1',
    'refs:',
    '    OPENAI_API_KEY: sk-other',
    'records:',
    '  owner/id:',
    '    kind: grant',
    '',
  ].join('\n')
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: target })
  assert.equal(merged.text, [
    'version: 1',
    'refs:',
    '    OPENAI_API_KEY: sk-other',
    '    DEEPSEEK_API_KEY: sk-source',
    'records:',
    '  owner/id:',
    '    kind: grant',
    '',
  ].join('\n'))
})

test('目标 refs 是空节时插在节首，缩进两格', () => {
  const target = ['version: 1', 'refs:', 'records:', '  owner/id:', '    kind: grant', ''].join('\n')
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: target })
  assert.equal(merged.text, [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-source',
    'records:',
    '  owner/id:',
    '    kind: grant',
    '',
  ].join('\n'))
})

test('目标 refs 是文件末尾的空节时追加到该节', () => {
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: 'version: 1\nrefs:\n' })
  assert.equal(merged.text, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-source\n')
})

test('目标 refs 是行内非空映射时展开成块式，原有条目原样保留', () => {
  const target = 'version: 1\nrefs: { OPENAI_API_KEY: sk-other }\nrecords: {}\n'
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: target })
  assert.equal(merged.text, [
    'version: 1',
    'refs:',
    '  OPENAI_API_KEY: sk-other',
    '  DEEPSEEK_API_KEY: sk-source',
    'records: {}',
    '',
  ].join('\n'))
})

test('源的 refs 是行内映射时也能搬，条目落地成块式', () => {
  const source = 'version: 1\nrefs: { ANTHROPIC_API_KEY: sk-ant }\n'
  const merged = mergeCredentialRefs({ sourceText: source, targetText: 'version: 1\nrecords: {}\n' })
  assert.deepEqual(merged.keys, ['ANTHROPIC_API_KEY'])
  assert.match(merged.text, /refs:\n {2}ANTHROPIC_API_KEY: sk-ant\n$/)
})

test('源的 refs 是行内空映射时没有可搬的条目', () => {
  const merged = mergeCredentialRefs({ sourceText: 'version: 1\nrefs: {}\n', targetText: null })
  assert.equal(merged.text, null)
  assert.deepEqual(merged.keys, [])
})

test('源条目缩进四格时搬到目标仍按目标的缩进', () => {
  const source = ['version: 1', 'refs:', '    DEEPSEEK_API_KEY: sk-source', ''].join('\n')
  const merged = mergeCredentialRefs({ sourceText: source, targetText: 'version: 1\nrefs:\n' })
  assert.equal(merged.text, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-source\n')
})

test('多行值搬进四格缩进的目标时续行跟着加深', () => {
  const source = [
    'version: 1',
    'refs:',
    '  MULTI_LINE: |-',
    '    line one',
    '    line two',
    '',
  ].join('\n')
  const target = ['version: 1', 'refs:', '    OPENAI_API_KEY: sk-other', ''].join('\n')
  const merged = mergeCredentialRefs({ sourceText: source, targetText: target })
  assert.match(merged.text, / {4}MULTI_LINE: \|-\n {6}line one\n {6}line two\n$/)
})

test('目标只有 records 的扁平布局不改动，宿主启动时会自行迁移', () => {
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: 'DEEPSEEK_API_KEY: sk-old\n' })
  assert.equal(merged.text, null)
  assert.deepEqual(merged.keys, [])
  assert.match(merged.notice, /pre-release 扁平布局/)
})

test('目标声明别的 version 时不猜格式，只报原因', () => {
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: 'version: 2\nrecords: {}\n' })
  assert.equal(merged.text, null)
  assert.match(merged.notice, /version 2/)
})

test('目标声明别的 version 但已有 refs 节时也不写入', () => {
  const merged = mergeCredentialRefs({
    sourceText: SOURCE_CREDENTIALS,
    targetText: 'version: 2\nrefs:\n  OPENAI_API_KEY: sk-other\n',
  })
  assert.equal(merged.text, null)
  assert.deepEqual(merged.keys, [])
  assert.match(merged.notice, /version 2/)
})

test('目标没有 version、却有 refs 节时也不写入——宿主同样解析不了', () => {
  const merged = mergeCredentialRefs({
    sourceText: SOURCE_CREDENTIALS,
    targetText: 'refs:\n  OPENAI_API_KEY: sk-other\n',
  })
  assert.equal(merged.text, null)
  assert.match(merged.notice, /pre-release 扁平布局/)
})

test('目标已经有重复的顶层 refs 时拒绝写，不加剧损坏', () => {
  assert.throws(
    () => mergeCredentialRefs({
      sourceText: SOURCE_CREDENTIALS,
      targetText: 'version: 1\nrefs:\n  A: x\nrefs:\n  B: y\n',
    }),
    /2 处顶层 refs/,
  )
})

test('refs 节里有认不出的条目时拒绝写，不猜拼接位置', () => {
  assert.throws(
    () => mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: 'version: 1\nrefs:\n  - A\n' }),
    /第 3 行：refs 节里的条目认不出/,
  )
})

test('目标顶层键带引号时仍认得是 refs 节，不会追加第二个', () => {
  const target = 'version: 1\n"refs": { OPENAI_API_KEY: sk-other }\n'
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: target })
  assert.equal(merged.text.match(/^(?:"refs"|refs):/gm).length, 1)
  assert.match(merged.text, /OPENAI_API_KEY: sk-other\n {2}DEEPSEEK_API_KEY: sk-source\n$/)
})

test('CRLF 的凭据文档仍只落一个 refs 节，条目完整', () => {
  const target = 'version: 1\r\nrefs: {}\r\nrecords:\r\n  x/y:\r\n    kind: grant\r\n'
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: target })
  assert.equal(merged.text.match(/^refs:/gm).length, 1)
  assert.match(merged.text, /refs:\n {2}DEEPSEEK_API_KEY: sk-source\n/)
  assert.match(merged.text, /x\/y:/)
})

test('合并只搬 refs，源的 records 不落进目标', () => {
  const merged = mergeCredentialRefs({ sourceText: SOURCE_CREDENTIALS, targetText: null })
  assert.ok(!merged.text.includes('deepseek-account-platform'))
  assert.ok(!merged.text.includes('kind: grant'))
})
