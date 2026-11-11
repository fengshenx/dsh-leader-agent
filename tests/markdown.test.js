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

test('渲染固定用 compact 变体：三个调用点都是窄容器', () => {
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

test('卡片详情、worker 回报与任务正文走 Markdown，旧回报回退纯文本', () => {
  assert.match(read('src/client/card-detail.js'), /createElement\(Markdown, \{ source: sections\.spec \}\)/)
  const view = read('src/client/agent-bubble-view.js')
  assert.match(view, /createElement\(Markdown, \{ source: body \}\)/)
  assert.match(view, /className: 'dsh-leader-agent-agent-bubble__plain'/)
  // 旧消息没有 report，回退的正文是协议行；纯文本才不会被 Markdown 折成一段。
  assert.match(read('src/client/worker-report-view.js'), /workerReportFormat\(data\)/)
  assert.match(
    read('src/client/agent-bubble-styles.js'),
    /\.dsh-leader-agent-agent-bubble__plain \{[^}]*white-space: pre-wrap/,
  )
  // 任务气泡正文也走同一个 Markdown 包装，不再按格式判据回退。
  const task = read('src/client/worker-task-view.js')
  assert.match(task, /createElement\(Markdown, \{ source: body, variant: 'compact' \}\)/)
  assert.equal(task.includes('hardBreakMarkdown'), false)
})

test('三处容器用 data-markdown-variant 钩子恢复正文与链接色', () => {
  const cases = [
    ['src/client/board-styles.js', 'dsh-leader-agent-card-detail-text'],
    ['src/client/agent-bubble-styles.js', 'dsh-leader-agent-agent-bubble__bubble'],
    ['src/client/worker-task-styles.js', 'dsh-leader-agent-worker-task__bubble'],
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

test('agent 气泡折叠按块级内容计算，退回 line-clamp 会失效', () => {
  const source = read('src/client/agent-bubble-styles.js')
  assert.equal(source.includes('-webkit-line-clamp'), false, 'line-clamp 只能截纯文本行，正文已是块级元素')
  // 裁剪落在正文层，气泡内的展开按钮不跟着被截
  assert.match(
    source,
    /\.dsh-leader-agent-agent-bubble__content\[data-collapsed='true'\] \{[^}]*max-height: calc\(2 \* var\(--dsh-leader-agent-bubble-line\) \+ 4px\)/,
  )
  const bubble = /\.dsh-leader-agent-agent-bubble__bubble \{([\s\S]*?)\n\}/.exec(source)
  assert.notEqual(bubble, null, '找不到气泡规则')
  assert.equal(/max-height|overflow: hidden/.test(bubble[1]), false, '气泡本身不该裁剪，否则按钮被一起截掉')
  // 行高必须取 compact 变体的值，否则折叠水位与实际排版差半行
  assert.match(source, /--dsh-leader-agent-bubble-line: calc\(20px \+ var\(--dsh-content-font-delta-secondary, 0px\)\)/)
})

test('agent 气泡沿用宿主消息气泡的底色，不自混前景色', () => {
  const source = read('src/client/agent-bubble-styles.js')
  assert.match(source, /background: var\(--dsw-specific-bubble\)/)
  // 按 label-primary 混百分比在深浅主题下强度不一致，看上去偏灰
  assert.equal(source.includes('color-mix(in srgb, var(--dsw-alias-label-primary) 2%'), false)
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(source), false, '样式里出现了写死的色值')
})

test('展开/收起按钮在气泡内，与正文是同一层的两个兄弟', () => {
  const view = read('src/client/agent-bubble-view.js')
  assert.match(view, /className: 'dsh-leader-agent-agent-bubble__bubble'/)
  assert.match(view, /className: 'dsh-leader-agent-agent-bubble__content'/)
  // 折叠状态挂在正文层，按钮不带折叠属性
  assert.match(view, /'data-collapsed': expanded \? undefined : 'true'/)
})

test('leader 任务用右侧用户气泡：无身份头、不折叠、正文与 assistant 同套 Markdown', () => {
  const view = read('src/client/worker-task-view.js')
  // 用户气泡没有头像、名字与折叠开关：这三样都是 agent 气泡的形态。
  assert.equal(view.includes('agentAvatarDataUri'), false)
  assert.equal(view.includes('AgentBubble'), false)
  assert.equal(view.includes('data-collapsed'), false)
  assert.equal(view.includes('展示更多'), false)
  assert.match(view, /className: 'dsh-leader-agent-worker-task__meta'/)
  // 正文与 assistant 内容同套 Markdown：交给 Markdown 包装，不补硬换行。
  assert.match(view, /from '\.\/markdown\.js'/)
  assert.match(view, /createElement\(Markdown, \{ source: body, variant: 'compact' \}\)/)
  assert.equal(view.includes('hardBreakMarkdown'), false)
  assert.equal(view.includes('UserTextRun'), false)
  // 底部 chrome 与官方消息同形：时间取消息时间，复制写原始正文。
  assert.match(view, /formatBubbleClock\(data\.time\)/)
  assert.match(view, /navigator\.clipboard\.writeText\(body\)/)
  assert.match(view, /productIcon\(copied \? 'check-outline' : 'copy-outline'/)
  // 气泡靠内容区分，没有独立视觉标识；title / aria-label 只做读屏与悬停提示。
  assert.match(view, /'aria-label': 'Leader 派发的任务'/)
  assert.match(view, /title: 'Leader 派发的任务'/)
  const styles = read('src/client/worker-task-styles.js')
  assert.match(styles, /\.dsh-leader-agent-worker-task \{[^}]*align-items: flex-end/)
  // 宽度上限取内容栏的 70.2%（至多 82%），内边距与宿主用户气泡一致。
  assert.match(styles, /max-width: min\(calc\(var\(--dsh-chat-content-width, 748px\) \* 0\.702\), 82%\)/)
  assert.match(styles, /\.dsh-leader-agent-worker-task__bubble \{[^}]*padding: 10px 16px;/)
  assert.match(styles, /\.dsh-leader-agent-worker-task__bubble \{[^}]*background: var\(--dsw-specific-bubble\)/)
  // 块排版交给 Markdown，气泡不再覆盖换行与行高。
  assert.equal(styles.includes('pre-wrap'), false)
  assert.doesNotMatch(styles, /line-height\s*:/)
  assert.equal(styles.includes('-webkit-line-clamp'), false)
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(styles), false, '样式里出现了写死的色值')
})
