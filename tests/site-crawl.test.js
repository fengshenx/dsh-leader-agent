/**
 * 落地页的抓取入口契约：robots.txt 声明 sitemap、sitemap 的 loc 是线上首页、404 不进索引。
 *
 * 这些文件不被任何构建校验，删掉或改错 URL 只会在线上静默失效；这里钉住三者的交叉引用。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SITE = 'https://fengshenx.github.io/dsh-leader-agent/'
const robots = readFileSync(new URL('../site/robots.txt', import.meta.url), 'utf8')
const sitemap = readFileSync(new URL('../site/sitemap.xml', import.meta.url), 'utf8')
const notFound = readFileSync(new URL('../site/404.html', import.meta.url), 'utf8')

test('robots.txt 放行全站，并把 sitemap 指向线上地址', () => {
  assert.match(robots, /^User-agent: \*$/m)
  assert.match(robots, /^Allow: \/$/m)
  assert.equal(robots.match(/^Sitemap: (\S+)$/m)?.[1], `${SITE}sitemap.xml`)
})

test('sitemap.xml 的 loc 与 canonical 同址', () => {
  assert.ok(sitemap.includes(`<loc>${SITE}</loc>`), 'sitemap 的 loc 必须是线上首页')
})

test('404.html 不进索引，并回链首页与仓库', () => {
  assert.match(notFound, /<meta name="robots" content="noindex">/)
  assert.match(notFound, /href="\/dsh-leader-agent\/"/)
  assert.match(notFound, /https:\/\/github\.com\/fengshenx\/dsh-leader-agent/)
  assert.doesNotMatch(notFound, /<script\b/, '404 页不挂分析脚本，避免错误路径污染站点流量')
})
