import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Markdown 渲染复用宿主基线模块里的 `MarkdownText`，组件本身依赖宿主注入的 react
// 与宿主包，`node:test` 环境里无法 import（同 `src/client/icons.js`）。能机械断言
// 的是接线方式：用哪个模块、构建期是否把它留在产物外、折叠为什么不能再用
// line-clamp。渲染效果由真机取证。
const here = dirname(fileURLToPath(import.meta.url))
const read = (path) => readFileSync(join(here, '..', path), 'utf8')

test('Markdown 走宿主基线模块，不自带解析器', () => {
  const source = read('src/client/markdown.js')
  assert.match(source, /from '@deepseek-ai\/dsh-client-ui-primitives'/)
  assert.match(source, /MarkdownText/)
  // 自带解析器或第三方 Markdown 库会在产物里打出第二份实现
  assert.equal(source.includes('parseMarkdown'), false)
  assert.equal(source.includes('marked'), false)
  assert.equal(source.includes('react-markdown'), false)
  // 原文一律作为文本交给宿主渲染器，这里不拼 HTML
  assert.equal(source.includes('dangerouslySetInnerHTML'), false)
  assert.equal(source.includes('innerHTML'), false)
})

test('渲染固定用 compact 变体：两处调用点都是窄容器', () => {
  const source = read('src/client/markdown.js')
  assert.match(source, /variant = 'compact'/)
})

test('构建期把 ui-primitives 留在产物外，与 react 同列', () => {
  const source = read('build/client-bundle.mjs')
  const match = /const BASELINE_EXTERNALS = \[(.*?)\]/s.exec(source)
  assert.notEqual(match, null, '找不到 BASELINE_EXTERNALS')
  const externals = match[1].split(',').map((item) => item.trim().replace(/^'|'$/g, '')).filter(Boolean)
  assert.ok(externals.includes('react'), 'react 不在 external 清单里')
  assert.ok(
    externals.includes('@deepseek-ai/dsh-client-ui-primitives'),
    'ui-primitives 不在 external 清单里，esbuild 会尝试把它打进产物',
  )
})

test('两处调用点都渲染 Markdown 组件，旧消息回退纯文本', () => {
  assert.match(read('src/client/card-detail.js'), /createElement\(Markdown, \{ source: sections\.spec \}\)/)
  const view = read('src/client/worker-report-view.js')
  assert.match(view, /createElement\(Markdown, \{ source: body \}\)/)
  // 旧消息没有 report，回退的正文是协议行；纯文本才不会被 Markdown 折成一段。
  assert.match(view, /workerReportFormat\(data\)/)
  assert.match(view, /className: 'dsh-leader-kit-worker-report__plain'/)
  assert.match(
    read('src/client/worker-report-styles.js'),
    /\.dsh-leader-kit-worker-report__plain \{[^}]*white-space: pre-wrap/,
  )
})

test('两处容器用 data-markdown-variant 钩子恢复正文与链接色', () => {
  const cases = [
    ['src/client/board-styles.js', 'dsh-leader-kit-card-detail-text'],
    ['src/client/worker-report-styles.js', 'dsh-leader-kit-worker-report__bubble'],
  ]
  for (const [path, container] of cases) {
    const source = read(path)
    // 宿主 compact 变体把正文设成三级标签色、链接设成 inherit；容器内按属性钩子压回原色
    assert.match(
      source,
      new RegExp(`\\.${container} \\[data-markdown-variant='compact'\\] \\{[^}]*color: var\\(--dsw-alias-label-primary\\)`),
      `${path} 没有把正文色恢复成 primary`,
    )
    assert.match(
      source,
      new RegExp(`\\.${container} \\[data-markdown-variant='compact'\\] a \\{[^}]*color: var\\(--dsw-alias-link\\)`),
      `${path} 没有把链接色恢复成 link`,
    )
    // 不自造色值：两个颜色都必须来自宿主令牌
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(source), false, `${path} 出现写死的色值`)
  }
})

test('worker 气泡折叠按块级内容计算，退回 line-clamp 会失效', () => {
  const source = read('src/client/worker-report-styles.js')
  assert.equal(source.includes('-webkit-line-clamp'), false, 'line-clamp 只能截纯文本行，正文已是块级元素')
  // 裁剪落在正文层，气泡内的展开按钮不跟着被截
  assert.match(
    source,
    /\.dsh-leader-kit-worker-report__content\[data-collapsed='true'\] \{[^}]*max-height: calc\(2 \* var\(--dsh-leader-kit-report-line\) \+ 4px\)/,
  )
  const bubble = /\.dsh-leader-kit-worker-report__bubble \{([\s\S]*?)\n\}/.exec(source)
  assert.notEqual(bubble, null, '找不到气泡规则')
  assert.equal(/max-height|overflow: hidden/.test(bubble[1]), false, '气泡本身不该裁剪，否则按钮被一起截掉')
  // 行高必须取 compact 变体的值，否则折叠水位与实际排版差半行
  assert.match(source, /--dsh-leader-kit-report-line: calc\(20px \+ var\(--dsh-content-font-delta-secondary, 0px\)\)/)
})

test('worker 气泡沿用宿主消息气泡的底色，不自混前景色', () => {
  const source = read('src/client/worker-report-styles.js')
  assert.match(source, /background: var\(--dsw-specific-bubble\)/)
  // 按 label-primary 混百分比在深浅主题下强度不一致，看上去偏灰
  assert.equal(source.includes('color-mix(in srgb, var(--dsw-alias-label-primary) 2%'), false)
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(source), false, '样式里出现了写死的色值')
})

test('展开/收起按钮在气泡内，与正文是同一层的两个兄弟', () => {
  const view = read('src/client/worker-report-view.js')
  assert.match(view, /className: 'dsh-leader-kit-worker-report__bubble'/)
  assert.match(view, /className: 'dsh-leader-kit-worker-report__content'/)
  // 折叠状态挂在正文层，按钮不带折叠属性
  assert.match(view, /'data-collapsed': expanded \? undefined : 'true'/)
})
