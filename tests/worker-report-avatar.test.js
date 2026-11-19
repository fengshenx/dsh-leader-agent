/** 白名单形状在 issue 里定死；测试从这里取期望集合，但每个名字的实际形状由 blobatar 决定。 */
const SHAPE_BANDS = [0.11, 0.35, 0.54, 0.9, 0.93]
const TONE_BANDS = [0.4, 0.8]
const SHAPES = ['round', 'organic', 'boxy', 'droplet', 'hexagon']
const LIGHT_BUBBLE = '#edf3fe'
const DARK_BUBBLE = '#2c2c2e'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { _layout } from 'blobatar'
import { buildAvatar } from '../src/client/worker-report-avatar.js'

function samplePath(d, steps = 48) {
  const tokens = d.match(/[A-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g)
  const points = []
  let index = 0
  let cursor = [0, 0]
  let start = [0, 0]
  const lineTo = (x, y) => {
    points.push([x, y])
    cursor = [x, y]
  }
  while (index < tokens.length) {
    const command = tokens[index++]
    if (command === 'M') {
      start = [Number(tokens[index++]), Number(tokens[index++])]
      cursor = start
      points.push(start)
    } else if (command === 'L') {
      lineTo(Number(tokens[index++]), Number(tokens[index++]))
    } else if (command === 'C') {
      const x1 = Number(tokens[index++])
      const y1 = Number(tokens[index++])
      const x2 = Number(tokens[index++])
      const y2 = Number(tokens[index++])
      const x = Number(tokens[index++])
      const y = Number(tokens[index++])
      const from = cursor
      for (let step = 1; step <= steps; step++) {
        const t = step / steps
        const rest = 1 - t
        lineTo(
          rest ** 3 * from[0] + 3 * rest ** 2 * t * x1 + 3 * rest * t ** 2 * x2 + t ** 3 * x,
          rest ** 3 * from[1] + 3 * rest ** 2 * t * y1 + 3 * rest * t ** 2 * y2 + t ** 3 * y,
        )
      }
    } else if (command === 'Q') {
      const x1 = Number(tokens[index++])
      const y1 = Number(tokens[index++])
      const x = Number(tokens[index++])
      const y = Number(tokens[index++])
      const from = cursor
      for (let step = 1; step <= steps; step++) {
        const t = step / steps
        const rest = 1 - t
        lineTo(rest ** 2 * from[0] + 2 * rest * t * x1 + t ** 2 * x, rest ** 2 * from[1] + 2 * rest * t * y1 + t ** 2 * y)
      }
    } else if (command === 'Z') {
      lineTo(start[0], start[1])
    }
  }
  return points
}

/**
 * 独立口径：把生产几何的 body path 采样成多边形，用扫描线求可见并集面积。
 * 不调用实现里的面积/凸包函数；droplet 若退回「两条 path 相加」，这里仍算并集。
 */
function scanlineUnionArea(avatar, rows = 512) {
  const polygons = avatar.body.map((d) => samplePath(d))
  let area = 0
  for (let row = 0; row < rows; row++) {
    const y = ((row + 0.5) * 100) / rows
    const intervals = []
    for (const polygon of polygons) {
      const crossings = []
      for (let index = 0; index < polygon.length; index++) {
        const [x0, y0] = polygon[index]
        const [x1, y1] = polygon[(index + 1) % polygon.length]
        if ((y0 > y) !== (y1 > y)) crossings.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0))
      }
      crossings.sort((left, right) => left - right)
      for (let index = 0; index + 1 < crossings.length; index += 2) {
        intervals.push([crossings[index], crossings[index + 1]])
      }
    }
    intervals.sort((left, right) => left[0] - right[0])
    let covered = 0
    let [start, end] = intervals[0] ?? [0, 0]
    for (const [nextStart, nextEnd] of intervals.slice(1)) {
      if (nextStart > end) {
        covered += end - start
        start = nextStart
        end = nextEnd
      } else {
        end = Math.max(end, nextEnd)
      }
    }
    covered += end - start
    area += covered * (100 / rows)
  }
  return area
}

function hexChannels(hex) {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16))
}

function channels(hex) {
  return hexChannels(hex).map((value) => value / 255)
}

function luminance(hex) {
  const linear = channels(hex).map((value) => {
    if (value <= 0.04045) return value / 12.92
    return ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrast(left, right) {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
}

function darkened(hex) {
  return '#' + hexChannels(hex).map((value) => Math.round(value * 0.62).toString(16).padStart(2, '0')).join('')
}

test('同一名字生成的头像几何一致，不同名字覆盖五种白名单形状', () => {
  const found = new Map()
  for (let index = 0; found.size < SHAPES.length && index < 2_000; index++) {
    const name = `worker-${index}`
    const avatar = buildAvatar(name)
    assert.deepEqual(avatar, buildAvatar(name))
    const expected = _layout(name, { traits: { shape: SHAPE_BANDS, tone: TONE_BANDS } })
    assert.equal(avatar.shape, expected.shape)
    assert.equal(SHAPES.includes(avatar.shape), true)
    if (!found.has(avatar.shape)) found.set(avatar.shape, name)
  }
  assert.deepEqual([...found.keys()].sort(), [...SHAPES].sort())
})

test('生产几何只有身体与眼睛路径，name 不进输出且颜色是合法十六进制', () => {
  const name = '<img src=x onerror="alert(1)">'
  const avatar = buildAvatar(name)
  assert.ok(avatar.body.length >= 1, '生产几何至少有一条身体 path')
  assert.ok(avatar.eyes.length >= 1, '生产几何至少有一条眼睛 path')
  assert.ok(avatar.body.every((d) => d.startsWith('M') && d.length > 20), '身体 path 不能是空串')
  assert.ok(avatar.eyes.every((d) => d.startsWith('M') && d.length > 5), '眼睛 path 不能是空串')
  assert.equal(avatar.strokeWidth, 2.5)
  for (const color of [avatar.head, avatar.stroke, avatar.eye]) assert.match(color, /^#[0-9a-f]{6}$/)
  const payload = JSON.stringify(avatar)
  assert.equal(payload.includes(name), false)
  assert.equal(payload.includes('<script'), false)
  assert.equal(payload.includes('onerror'), false)
  assert.equal(payload.includes('NaN'), false)
  assert.equal(payload.includes('undefined'), false)
  assert.equal(payload.includes('>>'), false)
  assert.equal(payload.includes('<'), false, '几何里不应出现 HTML 标记')
})

test('五种形状按可见并集统一到 34/100，宽高比在 0.926–1.087', () => {
  const seen = new Map()
  for (let index = 0; seen.size < SHAPES.length * 3 && index < 5_000; index++) {
    const name = `worker-${index}`
    const avatar = buildAvatar(name)
    const bucket = seen.get(avatar.shape) ?? []
    if (bucket.length >= 3) continue
    bucket.push({ avatar, layout: _layout(name, { traits: { shape: SHAPE_BANDS, tone: TONE_BANDS } }) })
    seen.set(avatar.shape, bucket)
  }
  for (const shape of SHAPES) {
    for (const { avatar, layout } of seen.get(shape)) {
      const radius = Math.sqrt(scanlineUnionArea(avatar) / Math.PI)
      assert.ok(Math.abs(radius - 34) < 0.1, `${shape} 的可见并集半径是 ${radius}`)
      const ratio = layout.body.rx / layout.body.ry
      assert.ok(ratio >= 0.926 && ratio <= 1.087, `${shape} 的宽高比是 ${ratio}`)
      assert.equal(avatar.strokeWidth, 2.5)
      if (shape === 'droplet') {
        assert.equal(avatar.body.length, 1, 'droplet 的并集应只有一个身体 path，避免内缝描边')
        const points = avatar.body.flatMap((d) => samplePath(d))
        assert.ok(Math.min(...points.map(([, y]) => y)) - 1.25 >= -0.01, 'droplet 尖顶的描边越过 viewBox 顶边')
        assert.ok(Math.max(...points.map(([, y]) => y)) + 1.25 <= 100.01, 'droplet 底部描边越过 viewBox')
      }
    }
  }
})

test('5000 个名字里所有 droplet 的可见并集半径都在 34±0.1', () => {
  let droplets = 0
  for (let index = 0; index < 5_000; index++) {
    const avatar = buildAvatar(`worker-${index}`)
    if (avatar.shape !== 'droplet') continue
    droplets++
    const radius = Math.sqrt(scanlineUnionArea(avatar) / Math.PI)
    assert.ok(Math.abs(radius - 34) < 0.1, `worker-${index} 的可见并集半径是 ${radius}`)
    assert.equal(avatar.body.length, 1, 'droplet 的并集应只有一个身体 path，避免内缝描边')
    const points = avatar.body.flatMap((d) => samplePath(d))
    assert.ok(Math.min(...points.map(([, y]) => y)) - 1.25 >= -0.01, `worker-${index} 的尖顶描边越过 viewBox 顶边`)
    assert.ok(Math.max(...points.map(([, y]) => y)) + 1.25 <= 100.01, `worker-${index} 的底部描边越过 viewBox`)
  }
  assert.ok(droplets > 0, '5000 个名字里应至少出现一个 droplet')
})

test('浅色描边、深色身体与眼睛的对比度达标', () => {
  for (let index = 0; index < 300; index++) {
    const avatar = buildAvatar(`worker-${index}`)
    assert.equal(avatar.stroke, darkened(avatar.head))
    assert.ok(contrast(avatar.stroke, LIGHT_BUBBLE) >= 3, `${avatar.head} 的描边对浅色气泡只有 ${contrast(avatar.stroke, LIGHT_BUBBLE)}:1`)
    assert.ok(contrast(avatar.head, DARK_BUBBLE) >= 3, `${avatar.head} 对深色气泡只有 ${contrast(avatar.head, DARK_BUBBLE)}:1`)
    assert.ok(contrast(avatar.eye, avatar.head) >= 4.5, `眼睛对 ${avatar.head} 只有 ${contrast(avatar.eye, avatar.head)}:1`)
  }
})

test('身体色只来自 mid / bright 两档 tone', () => {
  for (let index = 0; index < 100; index++) {
    const name = `worker-${index}`
    const avatar = buildAvatar(name)
    const options = { traits: { shape: SHAPE_BANDS, tone: TONE_BANDS } }
    const mid = _layout(name, { ...options, traits: { ...options.traits, tone: 0.4 } }).palette.head
    const bright = _layout(name, { ...options, traits: { ...options.traits, tone: 0.8 } }).palette.head
    assert.equal([mid, bright].includes(avatar.head), true)
  }
})
