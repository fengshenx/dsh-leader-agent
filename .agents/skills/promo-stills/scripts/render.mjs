#!/usr/bin/env node
/**
 * 把一张固定尺寸的 HTML 封面渲染成 PNG。
 *
 * 只做三件事：设置 viewport、等字体与图片、截图。设计本身留在 HTML 里，
 * 脚本不注入样式，也不改字号，避免“本地好看、导出变样”。
 *
 * 用法：
 *   node render.mjs --url cover.html --out cover.png --width 1080 --height 1920
 *   node render.mjs --help
 */

import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HELP = `HTML → PNG 封面渲染

用法:
  node render.mjs --url <html路径或URL> --out <png路径> [选项]

选项:
  --url <path|url>       HTML 文件路径或 http(s)/file URL（必填）
  --out <path>           输出 PNG（必填）
  --width <px>           视口宽，默认 1080
  --height <px>          视口高，默认 1920
  --scale <n>            设备像素比，默认 1；2 会导出 2 倍图
  --wait <ms>            字体/图片就绪后的额外等待，默认 300
  --full-page            截整页（默认只截视口）
  --help                 显示本帮助

示例:
  node .agents/skills/promo-stills/scripts/render.mjs \\
    --url .dev/promo/cover-9x16.html \\
    --out .dev/promo/cover-9x16.png \\
    --width 1080 --height 1920
`

/**
 * 解析参数；值与 `--` 开头的参数分开。
 * @param {string[]} argv - 不含 node 与脚本路径
 * @returns {Record<string, string | boolean>} 参数表
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const values = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      values.help = true
      continue
    }
    if (arg === '--full-page') {
      values['full-page'] = true
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`参数 --${key} 缺少值`)
    values[key] = next
    i += 1
  }
  return values
}

/**
 * 校验正整数参数。
 * @param {unknown} value - 原值
 * @param {string} name - 参数名
 * @param {number} fallback - 未提供时的默认值
 * @returns {number} 正整数
 */
function positiveInt(value, name, fallback) {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`--${name} 必须是正整数`)
  return number
}

/**
 * 把本地路径或 URL 统一成 Playwright 可打开的 URL。
 * @param {string} input - 路径或 URL
 * @returns {string} URL
 */
function toUrl(input) {
  if (/^(https?|file):\/\//.test(input)) return input
  return pathToFileURL(resolve(input)).href
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    process.stdout.write(HELP)
    return
  }
  if (typeof args.url !== 'string') throw new Error('缺少 --url')
  if (typeof args.out !== 'string') throw new Error('缺少 --out')

  const width = positiveInt(args.width, 'width', 1080)
  const height = positiveInt(args.height, 'height', 1920)
  const scale = args.scale === undefined ? 1 : positiveInt(args.scale, 'scale', 1)
  const wait = positiveInt(args.wait, 'wait', 300)

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: scale,
    })
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(toUrl(args.url), { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForFunction(
      () => [...document.images].every((image) => image.complete),
      null,
      { timeout: 15_000 },
    )
    const broken = await page.evaluate(
      () => [...document.images].filter((image) => image.naturalWidth === 0).map((image) => image.src),
    )
    if (broken.length > 0) throw new Error(`有 ${broken.length} 张图片加载失败：${broken.slice(0, 3).join(', ')}`)
    if (pageErrors.length > 0) throw new Error(`页面异常：${pageErrors.slice(0, 3).join(' | ')}`)
    await page.waitForTimeout(wait)
    await mkdir(dirname(resolve(args.out)), { recursive: true })
    await page.screenshot({
      path: args.out,
      fullPage: args['full-page'] === true,
      animations: 'disabled',
    })
    process.stdout.write(`已导出 ${args.out}（${width}×${height}，scale=${scale}）\n`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  process.stderr.write(`render: ${error.message}\n`)
  process.exit(1)
})
