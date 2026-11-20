/**
 * 落地页埋点的静态契约：15 个 data-track 元素 + 1 次 video play = 16 个事件。
 *
 * 浏览器里逐个点击的实测在 PR 证据里；这里把元素属性与基数的口径钉住，
 * 避免新增/删除 CTA 时 PR 里的「16 个」悄悄失真。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8')

/** 所有带 data-track 的开始标签。 */
const trackedTags = [...html.matchAll(/<[a-z][^>]*\bdata-track="[^"]+"[^>]*>/gi)].map((match) => match[0])

/**
 * 取一个固定属性值。
 * @param {string} tag - 开始标签
 * @param {string} name - 属性名
 * @returns {string | undefined} 属性值
 */
function attr(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
}

/** 事件名到出现位置的映射。 */
const occurrences = trackedTags.map((tag) => ({
  name: attr(tag, 'data-track'),
  place: attr(tag, 'data-track-place'),
  method: attr(tag, 'data-track-method'),
}))

test('落地页有 15 个 data-track 元素，加上 video play 共 16 个埋点', () => {
  assert.equal(trackedTags.length, 15)
  assert.match(html, /addEventListener\('play', function \(\) \{ track\('play-video'\); \}, \{ once: true \}\)/)
  assert.equal(occurrences.filter((item) => item.name === 'play-video').length, 0, 'play 由 video 监听器上报，不挂 data-track')
})

test('GitHub CTA 覆盖 nav / hero / install / footer', () => {
  assert.deepEqual(
    occurrences.filter((item) => item.name === 'outbound-github').map((item) => item.place).sort(),
    ['footer', 'hero', 'install', 'nav'],
  )
})

test('复制按钮覆盖 hero / web / desktop-cli', () => {
  assert.deepEqual(
    occurrences.filter((item) => item.name === 'copy-install').map((item) => item.method).sort(),
    ['desktop-cli', 'hero', 'web'],
  )
})

test('安装 tab 覆盖 web / desktop-gui / desktop-cli', () => {
  assert.deepEqual(
    occurrences.filter((item) => item.name === 'install-tab').map((item) => item.method).sort(),
    ['desktop-cli', 'desktop-gui', 'web'],
  )
})

test('中文入口与 npm 链接的 place 完整', () => {
  assert.deepEqual(
    occurrences.filter((item) => item.name === 'zh-readme').map((item) => item.place).sort(),
    ['footer', 'nav'],
  )
  assert.deepEqual(
    occurrences.filter((item) => item.name === 'view-npm').map((item) => item.place).sort(),
    ['footer', 'install', 'nav'],
  )
})
