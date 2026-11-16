#!/usr/bin/env node
/**
 * 生成 / 校验仓库根目录的 THIRD_PARTY_LICENSE。
 *
 * 清单不靠人肉维护：
 *
 * - `dependencies` 里的包是随包安装的运行时依赖；
 * - `devDependencies` 里除本文件配置的 `bundled` 之外都是构建/测试工具（不随包分发）；
 * - `bundled` 里的包在构建期被内联进 `lib/client.js`，许可全文必须随产物一起走；
 * - `references` 是借鉴过实现、但不随包分发的上游项目（许可全文存进 `scripts/third-party/`）。
 *
 * 包的版本、许可标识、来源 URL 与许可全文都从安装目录读取，不在配置里手抄；配置只
 * 补「用途」这类无法从 package.json 推断的事实。生成结果必须稳定：不带时间戳、
 * 按包名排序，`--check` 直接按字节比较。
 *
 * 用法：
 *   node scripts/third-party-license.mjs            # 写入
 *   node scripts/third-party-license.mjs --check    # 只校验（npm run check 用）
 *
 * @module dsh-leader-agent/scripts/third-party-license
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'THIRD_PARTY_LICENSE')
const PACKAGE_PATH = join(ROOT, 'package.json')
const CONFIG_PATH = join(ROOT, 'scripts/third-party-sources.json')

/**
 * 读 JSON 文件；坏文件直接抛，带路径。
 * @param {string} path - 绝对路径
 * @returns {any} 解析结果
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * 许可字段可能是字符串，也可能是旧式 `{ type }`。
 * @param {unknown} value - package.json 的 license 字段
 * @returns {string} 许可标识
 */
function licenseId(value) {
  if (typeof value === 'string' && value !== '') return value
  if (value !== null && typeof value === 'object' && typeof value.type === 'string') return value.type
  return 'UNKNOWN'
}

/**
 * 归一化 package.json 里的来源 URL。
 * @param {object} meta - package.json
 * @returns {string} 可点击的 https URL；没有来源时为空串
 */
function sourceUrl(meta) {
  const repository = meta.repository
  const raw = typeof repository === 'string'
    ? repository
    : typeof repository?.url === 'string' ? repository.url : meta.homepage
  if (typeof raw !== 'string' || raw === '') return ''
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
}

/**
 * 在包目录里找许可全文。
 *
 * npm 生态的命名不统一（LICENSE / LICENSE.md / LICENCE / COPYING）；取排序后的
 * 第一个，避免同一包有多个副本时输出漂移。
 *
 * @param {string} dir - 包目录
 * @returns {string} 许可全文；没有时为空串
 */
function licenseText(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return ''
  }
  const candidates = names
    .filter((name) => /^(licen[cs]e|copying|copyright)(\.|$)/i.test(name))
    .sort((left, right) => left.localeCompare(right))
  for (const name of candidates) {
    const path = join(dir, name)
    if (statSync(path, { throwIfNoEntry: false })?.isFile() === true) return readFileSync(path, 'utf8').trim()
  }
  return ''
}

/**
 * 从许可全文里取版权行；工具类包的许可全文不随本文件分发时允许缺失。
 * @param {string} text - 许可全文
 * @returns {string} 版权行；没有时为空串
 */
function copyrightLine(text) {
  return text.split('\n').find((line) => /^\s*copyright\b/i.test(line))?.trim() ?? ''
}

/**
 * 读一个已安装依赖的元数据与许可全文。
 * @param {string} name - 包名
 * @param {'runtime' | 'bundled' | 'tool'} kind - 分发方式
 * @returns {object} 条目
 */
function dependencyEntry(name, kind) {
  const dir = join(ROOT, 'node_modules', name)
  if (statSync(join(dir, 'package.json'), { throwIfNoEntry: false })?.isFile() !== true) {
    throw new Error(`依赖 ${name} 未安装：先在仓库根目录跑 npm install`)
  }
  const meta = readJson(join(dir, 'package.json'))
  const text = licenseText(dir)
  if (kind !== 'tool' && text === '') {
    throw new Error(`${name} 的许可全文缺失：${kind === 'bundled' ? '内联进客户端产物' : '随包安装'}的代码必须带上许可全文`)
  }
  return {
    name,
    version: typeof meta.version === 'string' ? meta.version : 'UNKNOWN',
    license: licenseId(meta.license),
    url: sourceUrl(meta),
    copyright: copyrightLine(text),
    text,
  }
}

/**
 * 许可全文段落。
 * @param {object} entry - 依赖或参考条目
 * @returns {string} Markdown 片段
 */
function licenseBlock(entry) {
  return [
    '```text',
    entry.text,
    '```',
  ].join('\n')
}

/**
 * 依赖条目的公共头。
 * @param {object} entry - 条目
 * @param {string} usage - 用途
 * @returns {string[]} Markdown 行
 */
function entryHead(entry, usage) {
  const lines = [
    `### ${entry.name} ${entry.version}（${entry.license}）`,
    '',
    `- 来源：${entry.url === '' ? '（package.json 未声明）' : entry.url}`,
  ]
  if (entry.copyright !== '') lines.push(`- 版权：${entry.copyright}`)
  lines.push(`- 用途：${usage}`, '')
  return lines
}

/**
 * 生成整份文件。
 * @returns {string} THIRD_PARTY_LICENSE 内容
 */
function render() {
  const pkg = readJson(PACKAGE_PATH)
  const config = readJson(CONFIG_PATH)
  if (config?.version !== 1) throw new Error('scripts/third-party-sources.json 的 version 必须是 1')
  if (!Array.isArray(pkg.files) || !pkg.files.includes('THIRD_PARTY_LICENSE')) {
    throw new Error('package.json 的 files 没有收录 THIRD_PARTY_LICENSE')
  }
  const bundledConfig = config.bundled ?? {}
  for (const [name, usage] of Object.entries(bundledConfig)) {
    if (typeof usage !== 'string' || usage === '') {
      throw new Error(`scripts/third-party-sources.json 的 bundled.${name} 缺少用途说明`)
    }
  }
  const runtimeNames = Object.keys(pkg.dependencies ?? {}).sort()
  const devNames = Object.keys(pkg.devDependencies ?? {}).sort()
  const bundledNames = Object.keys(bundledConfig).sort()
  const toolNames = devNames.filter((name) => !bundledNames.includes(name))
  const runtime = runtimeNames.map((name) => dependencyEntry(name, 'runtime'))
  const bundled = bundledNames.map((name) => dependencyEntry(name, 'bundled'))
  const tools = toolNames.map((name) => dependencyEntry(name, 'tool'))
  const references = (Array.isArray(config.references) ? config.references : []).map((entry) => {
    if (typeof entry?.name !== 'string' || typeof entry?.licenseFile !== 'string') {
      throw new Error('third-party-sources.json 的 references 条目缺 name 或 licenseFile')
    }
    const text = readFileSync(join(ROOT, entry.licenseFile), 'utf8').trim()
    if (text === '') throw new Error(`${entry.licenseFile} 是空的`)
    return {
      name: entry.name,
      version: typeof entry.version === 'string' ? entry.version : 'UNKNOWN',
      license: typeof entry.license === 'string' ? entry.license : 'UNKNOWN',
      url: typeof entry.url === 'string' ? entry.url : '',
      usage: typeof entry.usage === 'string' ? entry.usage : '',
      usedIn: Array.isArray(entry.usedIn) ? entry.usedIn : [],
      text,
      copyright: copyrightLine(text),
    }
  })

  const lines = [
    '# THIRD_PARTY_LICENSE',
    '',
    '本文件由 `node scripts/third-party-license.mjs` 生成，请勿手改。',
    '重新生成：`npm run licenses`；校验：`npm run licenses:check`（已并入 `npm run check`）。',
    '',
    '本包（dsh-leader-agent）自身以 MIT 许可发布，见 `LICENSE`。下面只列第三方代码与参考实现。',
    '',
    '## 随客户端产物分发的第三方代码',
    '',
  ]

  if (bundled.length === 0) {
    lines.push('无。', '')
  } else {
    for (const entry of bundled) {
      lines.push(...entryHead(entry, bundledConfig[entry.name]), licenseBlock(entry), '')
    }
  }

  lines.push(
    '## 随包安装的运行时依赖',
    '',
  )
  if (runtime.length === 0) {
    lines.push('无。运行时只依赖宿主提供的基线模块（React、React DOM、`@deepseek-ai/dsh-client-ui-primitives`），它们由宿主模块表提供，不随本包分发。', '')
  } else {
    for (const entry of runtime) {
      lines.push(...entryHead(entry, '运行时依赖，随 npm 包安装。'), licenseBlock(entry), '')
    }
  }

  lines.push(
    '## 参考实现（未随包分发）',
    '',
  )
  if (references.length === 0) {
    lines.push('无。', '')
  } else {
    for (const entry of references) {
      lines.push(`### ${entry.name} ${entry.version}（${entry.license}）`, '')
      lines.push(`- 来源：${entry.url === '' ? '（未声明）' : entry.url}`)
      if (entry.copyright !== '') lines.push(`- 版权：${entry.copyright}`)
      if (entry.usedIn.length > 0) {
        lines.push(`- 参考位置：${entry.usedIn.map((path) => '`' + path + '`').join('、')}`)
      }
      lines.push(`- 参考内容：${entry.usage}`, '')
      lines.push(licenseBlock(entry), '')
    }
  }

  lines.push(
    '## 构建与测试工具（不随包分发）',
    '',
  )
  if (tools.length === 0) {
    lines.push('无。', '')
  } else {
    lines.push('| 包 | 版本 | 许可 | 来源 |', '| --- | --- | --- | --- |')
    for (const entry of tools) {
      lines.push(`| ${entry.name} | ${entry.version} | ${entry.license} | ${entry.url === '' ? '—' : entry.url} |`)
    }
    lines.push(
      '',
      '这些工具只在开发、构建或测试时使用，不进入 npm 包或客户端产物；完整许可文本在各自安装目录的 `LICENSE` 文件里。',
      '',
    )
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/**
 * 入口。
 * @returns {void}
 */
function main() {
  const check = process.argv.includes('--check')
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--check')
  if (unknown.length > 0) throw new Error(`未知参数：${unknown.join(' ')}`)
  const expected = render()
  if (check) {
    let actual = ''
    try {
      actual = readFileSync(TARGET, 'utf8')
    } catch {
      // 文件不存在按过期处理，与内容不一致走同一条修复路径。
    }
    if (actual !== expected) {
      throw new Error('THIRD_PARTY_LICENSE 不存在或已过期：运行 npm run licenses 重新生成')
    }
    console.log('THIRD_PARTY_LICENSE 校验通过')
    return
  }
  writeFileSync(TARGET, expected)
  console.log(`THIRD_PARTY_LICENSE 已更新（${expected.split('\n### ').length - 1} 个第三方条目）`)
}

try {
  main()
} catch (error) {
  console.error('third-party-license:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
