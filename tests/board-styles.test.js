import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// 宿主对 packages/ 有 ui-theme 的样式 scanner（半径字面量、elevation 与中性 border
// 配对、滚动条档位），仓外插件的 src/client/ 不在那批 scanner 的覆盖范围里。这里
// 只守住本仓依赖的几条宿主硬规则，不做像素级断言——样式表写在 JS 模板字符串里，
// 没有 CSS 文件可给宿主工具扫描。
const stylesPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src/client/board-styles.js')

/**
 * 取出模板字符串里的样式文本。反引号会截断模板，所以样式文本里不含反引号，
 * 从标记之后到下一个反引号就是全部内容。
 * @returns {string} 样式文本
 */
function readStyleText() {
  const source = readFileSync(stylesPath, 'utf8')
  const marker = 'const STYLE_TEXT = `'
  const markerAt = source.indexOf(marker)
  assert.notEqual(markerAt, -1, '找不到 STYLE_TEXT 模板字符串')
  const bodyAt = markerAt + marker.length
  const endAt = source.indexOf('`', bodyAt)
  assert.notEqual(endAt, -1, 'STYLE_TEXT 模板字符串没有闭合')
  return source.slice(bodyAt, endAt)
}

/**
 * 读一条规则的声明表。
 * @param {string} body - 花括号之间的文本
 * @returns {Record<string, string>} 属性到取值的映射
 */
function readDeclarations(body) {
  const declarations = {}
  for (const chunk of body.split(';')) {
    const text = chunk.trim()
    if (text === '') continue
    const colonAt = text.indexOf(':')
    assert.notEqual(colonAt, -1, `声明缺冒号: ${text}`)
    declarations[text.slice(0, colonAt).trim()] = text.slice(colonAt + 1).replace(/\s+/g, ' ').trim()
  }
  return declarations
}

/**
 * 拆出样式规则。at-rule 块只留下整条链，叶子规则记选择器、声明与所处 at-rule。
 * @param {string} css - 已去注释的样式文本
 * @returns {{ selector: string, declarations: Record<string, string>, atRules: string[] }[]} 规则列表
 */
function collectRules(css) {
  const rules = []
  const open = []
  let cursor = 0
  let bodyAt = 0
  while (cursor < css.length) {
    const char = css[cursor]
    if (char === '{') {
      open.push(css.slice(bodyAt, cursor).replace(/\s+/g, ' ').trim())
      cursor += 1
      bodyAt = cursor
      continue
    }
    if (char === '}') {
      const prelude = open.pop()
      assert.notEqual(prelude, undefined, '样式文本的花括号不配对')
      if (!prelude.startsWith('@')) {
        rules.push({ selector: prelude, declarations: readDeclarations(css.slice(bodyAt, cursor)), atRules: [...open] })
      }
      cursor += 1
      bodyAt = cursor
      continue
    }
    cursor += 1
  }
  assert.deepEqual(open, [], '样式文本的花括号不配对')
  return rules
}

const rules = collectRules(readStyleText().replace(/\/\*[\s\S]*?\*\//g, ''))

test('样式表能被拆成规则（拆不开会让下面几条用例空转）', () => {
  assert.ok(rules.length >= 50, `只拆出 ${rules.length} 条规则`)
  assert.ok(rules.some((rule) => rule.selector === '.dsh-leader-agent-board-card'))
})

test('50% 与 999px 全圆声明都配对 corner-shape: round，不被主题的 superellipse 压成方角', () => {
  const rounds = rules.filter((rule) => rule.declarations['border-radius'] === '50%' || rule.declarations['border-radius'] === '999px')
  assert.ok(rounds.length >= 3, `只找到 ${rounds.length} 条全圆规则`)
  for (const rule of rounds) {
    assert.equal(rule.declarations['corner-shape'], 'round', `${rule.selector} 的全圆没退出主题曲线`)
  }
})

test('可点击产物链接在 hover 与键盘焦点下都出点状下划线', () => {
  for (const selector of ['.dsh-leader-agent-board-link-chip', '.dsh-leader-agent-card-detail-link']) {
    const focus = rules.find((rule) => rule.selector === `${selector}:focus-visible`)
    assert.notEqual(focus, undefined, `${selector} 缺 :focus-visible 规则`)
    assert.equal(focus.declarations['text-decoration'], 'underline dotted', `${selector} 的焦点态没有点状下划线`)
    const hover = rules.find((rule) => rule.selector === `${selector}:hover`)
    assert.equal(hover?.declarations['text-decoration'], 'underline dotted', `${selector} 的 hover 没有点状下划线`)
  }
})

test('chip 的下划线偏移取 1px，真机上整条画得出来', () => {
  // 这是一个真机读数定下来的字面量，不是几何推导：隔离实例里逐档改 offset 再重建
  // 产物，1px 点线完整、离底边框有余量；3px 仍然画得出来但已压在底边框上、与发丝
  // 线糊成一条；再往上整条落到 padding box 外被两层 overflow 裁掉（两处读数分别
  // 从 4px 与 5px 起）。CSS 声明层看不出基线位置，所以这里只能守字面量——谁要改它
  // 得先有新的真机读数
  for (const selector of ['.dsh-leader-agent-board-link-chip:focus-visible', '.dsh-leader-agent-board-link-chip:hover']) {
    const rule = rules.find((item) => item.selector === selector)
    assert.notEqual(rule, undefined, `缺 ${selector} 规则`)
    assert.equal(rule.declarations['text-underline-offset'], '1px', `${selector} 的下划线偏移不是真机定下来的 1px`)
  }
})

test('链路行的裁切带里，chip 的焦点环内嵌绘制', () => {
  const focus = rules.find((rule) => rule.selector === '.dsh-leader-agent-board-link-chip:focus-visible')
  assert.notEqual(focus, undefined, 'chip 缺 :focus-visible 规则')
  const offset = Number.parseFloat(focus.declarations['outline-offset'] ?? '')
  // 必须严格小于 0：0 的环仍画在边框外侧，会被 .dsh-leader-agent-board-links 的
  // overflow 裁成左右两段竖条
  assert.ok(Number.isFinite(offset) && offset < 0, 'chip 的焦点环外扩时会被 .dsh-leader-agent-board-links 的 overflow 裁掉')
})

test('引用的 --dsw-* token 都在白名单里（未定义的 token 会静默回落成空值）', () => {
  // 白名单只收 dsh-v0.2.1-rc.2（engines.dsh 下限）里确实定义过的名字，逐条在宿主
  // tag 源码核过。名字打错时 CSS 不报错、只是取值变空，真机上表现为「样式没生效」
  const known = new Set([
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-skeleton',
    '--dsw-alias-border-l3',
    '--dsw-alias-border-l4',
    '--dsw-alias-button-elevated-fill',
    '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-label-caption',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-link',
    '--dsw-alias-state-business-primary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-label',
    '--dsw-alias-state-warn-primary',
    '--dsw-elevation-panel',
    '--dsw-elevation-stroke',
    '--dsw-elevation-stroke-color',
    '--dsw-focus-ring-color',
    '--dsw-focus-ring-width',
    '--dsw-font-s-strong-14-font-size',
    '--dsw-font-s-strong-14-font-weight',
    '--dsw-font-s-strong-14-line-height',
    '--dsw-font-xs-13-font-size',
    '--dsw-font-xs-13-line-height',
    '--dsw-radius-lg',
    '--dsw-radius-md',
    '--dsw-radius-panel',
    '--dsw-radius-sm',
    '--dsw-radius-xl',
    '--dsw-radius-xs',
    '--dsw-static-blue-500',
  ])
  const referenced = new Set()
  for (const rule of rules) {
    for (const value of Object.values(rule.declarations)) {
      for (const match of value.matchAll(/var\((--dsw-[a-z0-9-]+)/g)) referenced.add(match[1])
    }
  }
  assert.ok(referenced.size >= 10, `只找到 ${referenced.size} 个 --dsw-* token`)
  const unknown = [...referenced].filter((name) => !known.has(name))
  assert.deepEqual(unknown, [], `用了未核对过的宿主 token: ${unknown.join(', ')}`)
})

test('信号点的状态变体写在基础规则之后，否则背景与透明度会被基础档覆盖', () => {
  const baseAt = rules.findIndex((rule) => rule.selector === '.dsh-leader-agent-board-signal')
  assert.notEqual(baseAt, -1, '缺信号点基础规则')
  // 只认状态名：signal-slot 这类容器不是变体，按前缀匹配会把它误算进来
  const states = 'waiting|unread|running|attention|idle|unknown|none|empty'
  const variants = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => new RegExp(`^\\.dsh-leader-agent-board-(signal|slot-dot)-(${states})$`).test(rule.selector))
  assert.ok(variants.length >= 8, `只找到 ${variants.length} 条状态变体`)
  for (const { rule, index } of variants) {
    assert.ok(index > baseAt, `${rule.selector} 写在基础规则之前，同特异性下会被覆盖`)
  }
})

test('所有 :hover 规则都在 hover 媒体查询里，触屏点按不会粘住悬停态', () => {
  const hovers = rules.filter((rule) => rule.selector.includes(':hover'))
  assert.ok(hovers.length >= 5, `只找到 ${hovers.length} 条 :hover 规则`)
  for (const rule of hovers) {
    assert.ok(
      rule.atRules.some((atRule) => atRule.startsWith('@media (hover: hover)')),
      `${rule.selector} 的 :hover 不在 @media (hover: hover) 里`,
    )
  }
})

test('中性 --dsw-alias-border-* 边框一律 0.5px 发丝线', () => {
  const hairlines = []
  for (const rule of rules) {
    for (const [property, value] of Object.entries(rule.declarations)) {
      if (!/^border(-(top|right|bottom|left))?$/.test(property)) continue
      if (!value.includes('var(--dsw-alias-border-')) continue
      hairlines.push(rule.selector)
      assert.ok(value.startsWith('0.5px '), `${rule.selector} 的中性边框不是 0.5px: ${value}`)
    }
  }
  assert.ok(hairlines.length >= 4, `只找到 ${hairlines.length} 条中性边框`)
})

test('中性 border 与 elevation 投影不同时出现在一条规则里', () => {
  const elevated = rules.filter((rule) => (rule.declarations['box-shadow'] ?? '').includes('var(--dsw-elevation-'))
  assert.ok(elevated.length >= 2, `只找到 ${elevated.length} 条 elevation 投影规则`)
  for (const rule of elevated) {
    const conflicting = Object.entries(rule.declarations).some(
      ([property, value]) => /^border(-(top|right|bottom|left))?$/.test(property) && value.includes('var(--dsw-alias-border-'),
    )
    assert.equal(conflicting, false, `${rule.selector} 同时有中性 border 与 elevation 投影`)
  }
})
