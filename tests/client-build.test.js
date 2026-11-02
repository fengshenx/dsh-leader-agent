import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClient, parseBuildArgs } from '../build/client-bundle.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'src/client/index.js')

/** 宿主冻结模块表里的基线模块：产物只能引用，不能内联。 */
const BASELINE_MODULES = ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

/**
 * 造一个隔离的产物目录，避免覆盖仓库里的 `lib/client.js`。
 *
 * @returns {{ dir: string, outfile: string }} 临时目录与产物路径
 */
function makeOutfile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-leader-kit-client-'))
  return { dir, outfile: join(dir, 'lib', 'client.js') }
}

/**
 * 断言产物把某个模块留在外面（通过工厂的 require 解析）。
 *
 * @param {string} source - 产物源码
 * @param {string} name - 模块名
 * @returns {void} 无返回
 */
function assertExternal(source, name) {
  assert.ok(source.includes(`require(${JSON.stringify(name)})`), `产物应保留对 ${name} 的外部 require`)
}

test('无参数按单次构建处理，--watch 打开监听', () => {
  assert.deepEqual(parseBuildArgs([]), { watch: false })
  assert.deepEqual(parseBuildArgs(['--watch']), { watch: true })
})

test('未知参数直接报错', () => {
  assert.throws(() => parseBuildArgs(['--watch', '--minify']), /未知参数: --minify/)
})

test('产物保持 closure-factory 外壳，基线模块留给宿主模块表', async () => {
  const { dir, outfile } = makeOutfile()
  try {
    await buildClient({ entry: ENTRY, outfile })
    const source = readFileSync(outfile, 'utf8')
    assert.ok(source.startsWith('window.__ModuleLoader__.load({ id: "dsh-leader-kit", factory: (require) => {'))
    assert.ok(source.trimEnd().endsWith('return module.exports; } });'))
    // 真实入口图里的基线模块都必须 external，不能有第二份 React / ui-primitives 实例。
    for (const name of BASELINE_MODULES) assertExternal(source, name)
    // 原子写：staging 在成功后 rename 走，产物目录里只剩正式文件。
    assert.deepEqual(readdirSync(join(dir, 'lib')), ['client.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('基线模块清单漂移会直接变红：fixture 同时 import 三种基线模块', async () => {
  const { dir, outfile } = makeOutfile()
  const entry = join(dir, 'fixture-entry.js')
  try {
    // 独立于真实入口图：即使将来 src/client 不再用某个基线包，external 清单
    // 漏项也会在这里被 esbuild 的解析失败或「内联进产物」抓住。
    writeFileSync(entry, [
      "import 'react'",
      "import 'react-dom'",
      "import '@deepseek-ai/dsh-client-ui-primitives'",
      '',
    ].join('\n'))
    await buildClient({ entry, outfile })
    const source = readFileSync(outfile, 'utf8')
    for (const name of BASELINE_MODULES) assertExternal(source, name)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('构建失败保留上一份完整产物，不留 staging', async () => {
  const { dir, outfile } = makeOutfile()
  try {
    await buildClient({ entry: ENTRY, outfile })
    const built = readFileSync(outfile, 'utf8')

    await assert.rejects(() => buildClient({
      entry: join(ROOT, 'src/client/__missing__.js'), outfile, logLevel: 'silent',
    }))

    assert.equal(readFileSync(outfile, 'utf8'), built)
    assert.deepEqual(readdirSync(join(dir, 'lib')), ['client.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
