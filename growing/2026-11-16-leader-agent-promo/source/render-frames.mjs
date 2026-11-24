#!/usr/bin/env node
/**
 * 逐帧渲染宣传片，修正 60fps 下大字栅格抖动。
 *
 * 方法（v4 起，v5 沿用）：
 * - 每个场景单元只开一个页面（1080×1920），页面固定在 `?capture&t=0`，不轮转页面；
 * - 逐帧 `window.__promo.seek(i / fps)`，再等两次 requestAnimationFrame 才截图，
 *   让 seek 后的字体栅格化落定；
 * - 帧号按 `Math.round(场景起点 × fps)` 切，最后一帧用 `Math.ceil(duration × fps)`；
 * - 6 个 worker 并行，每个 worker 顺序截自己那组场景，避免同帧竞争。
 *
 * 用法（仓根执行，需本地 playwright 与 chromium）：
 *   node growing/2026-11-16-leader-agent-promo/source/render-frames.mjs \
 *     --out .dev/promo/frames-v5
 *
 * 只读本文件同目录的 promo.html 与 ../timeline.json，不写死机器路径。
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 读命令行参数 `--name value`。 */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const outDir = path.resolve(arg('out', '.dev/promo/frames'))
const htmlPath = path.resolve(arg('html', path.join(here, 'promo.html')))
const timelinePath = path.resolve(arg('timeline', path.join(here, '..', 'timeline.json')))
const timeline = JSON.parse(fs.readFileSync(timelinePath, 'utf8'))
const fps = timeline.fps
const duration = timeline.duration
const total = Math.ceil(duration * fps)

// 场景边界来自 timeline：S4 的 s4a/s4b/s4c 是三个单元，与时间轴一致。
const bounds = [...timeline.segments.map((segment) => segment.start), duration]
const units = timeline.segments.map((segment, index) => ({
  name: segment.key,
  start: Math.round(bounds[index] * fps),
  end: index === timeline.segments.length - 1 ? total : Math.round(bounds[index + 1] * fps),
}))

const WORKERS = 6
const buckets = Array.from({ length: WORKERS }, () => [])
units.forEach((unit, index) => buckets[index % WORKERS].push(unit))

fs.mkdirSync(outDir, { recursive: true })
for (const file of fs.readdirSync(outDir)) {
  if (file.endsWith('.jpg')) fs.unlinkSync(path.join(outDir, file))
}

const browser = await chromium.launch()
const url = `${pathToFileURL(htmlPath).href}?capture&t=0`
let done = 0
const started = Date.now()
await Promise.all(buckets.map(async (bucket) => {
  for (const unit of bucket) {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 })
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__promo?.duration > 0)
    for (let i = unit.start; i < unit.end; i += 1) {
      const t = Math.min(duration, i / fps)
      await page.evaluate((time) => window.__promo.seek(time), t)
      // 等两帧：让 seek 后的文字栅格化落定再截图，避免逐帧边缘抖动。
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.screenshot({ path: path.join(outDir, `${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 85 })
      done += 1
      if (done % 600 === 0) console.log(`${done}/${total} (${((Date.now() - started) / 1000).toFixed(0)}s)`)
    }
    await page.close()
    console.log(`unit ${unit.name} done (${unit.start}-${unit.end - 1})`)
  }
}))
await browser.close()
console.log(JSON.stringify({ total, fps, duration, workers: WORKERS, units, seconds: +((Date.now() - started) / 1000).toFixed(1) }))
