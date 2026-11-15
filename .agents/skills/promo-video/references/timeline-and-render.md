# 时间轴与录制

这条流水线只有一个真源：**旁白的实测时长**。动画、字幕、场景起止都从它算出来。

## 1. 从 timeline.json 起算

合成、测长、补静音、响度标准化与 `timeline.json` 字段定义的唯一归属是 [`doubao-tts`](../../doubao-tts/SKILL.md) 的“测长、补静音与拼接”和“时间轴接口”两节。这里只消费它的读数：

- 每段 `speech / lead / tail / duration` 都是实测值，`duration = lead + speech + tail`。
- `starts[key]` 是前面所有 `duration` 的累加，`s1` 从 0 开始。
- 改任何一句旁白，先回 `doubao-tts` 重新测长，再重算后面所有起点；不要只改一个场景的 `end` 而造成重叠。

## 2. 时间轴

```js
const TL = {
  s1: { start: 0, end: 8.958 },
  s2: { start: 8.958, end: 18.796 },
  s3: { start: 18.796, end: 27.246 },
  s4: { start: 27.246, end: 49.806, b: 6.918, c: 15.708 },
  s5: { start: 49.806, end: 59.096 },
  s6: { start: 59.096, end: 66.914 },
}
const DURATION = 66.914
```

- `s4.b` / `s4.c` 是相对 `s4.start` 的局部偏移：`b = s4b.start - s4.start`。
- 场景交叉淡化 0.45 秒；旁白在场景开始后 `lead` 秒进入。
- 字幕起点 = `start + lead`，终点 = 起点 + `speech`。
- 末屏不淡出：`sceneOpacity` 对最后一个场景返回 1，最后一帧停在品牌。

### 字幕 SRT

SRT 从同一份 `timeline.json` 生成，不手写时间码：

```sh
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs"
const [input, output] = process.argv.slice(1)
const timeline = JSON.parse(readFileSync(input, "utf8"))
if (!Array.isArray(timeline.segments) || typeof timeline.starts !== "object") {
  throw new Error("timeline.json 缺少 segments 或 starts")
}
const pad = (value, width = 2) => String(value).padStart(width, "0")
const stamp = (seconds) => {
  const ms = Math.round(seconds * 1000)
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}
let index = 0
const blocks = []
for (const segment of timeline.segments) {
  const start = timeline.starts[segment.key]
  const { lead, speech, text } = segment
  if (typeof start !== "number" || typeof lead !== "number" || typeof speech !== "number" || typeof text !== "string" || text.trim() === "") {
    throw new Error(`段 ${segment.key} 缺 starts/lead/speech/text`)
  }
  index += 1
  blocks.push(String(index), `${stamp(start + lead)} --> ${stamp(start + lead + speech)}`, text.trim(), "")
}
writeFileSync(output, blocks.join("\n"))
' .dev/promo/timeline.json .dev/promo/captions.srt
```

`text` 就是该段旁白的字幕原文；缺 `starts` / `lead` / `speech` / `text` 时脚本直接失败，不会写出空字幕。

## 3. HTML 契约

固定舞台，内部坐标不随窗口变化：

```html
<div id="stage" style="width:1080px;height:1920px;transform-origin:0 0">
  <section id="s1" class="scene">...</section>
  ...
</div>
```

适配：

```js
const scale = Math.min(innerWidth / 1080, innerHeight / 1920)
stage.style.transform = `scale(${scale})`
```

- 场景透明度只做交叉淡化；场景内部动画用 `local = t - scene.start`。
- 所有动画必须由 `t` 驱动：capture 暂停时画面要完全静止，否则预滚测不出来。
- 提供 `?capture`：隐藏 HUD/控制/重播层，加载后 `seek(0)` + `pause()`，**不自动播放**；`?capture&t=<seconds>` 则 `seek(t)` 后暂停，用于静帧。
- 暴露一个只读调试对象：`window.__promo = { duration, seek, play, pause, time, playing }`。
- 录制模式下不要显示光标、hover 态或浏览器滚动条。

## 4. 录制

Playwright 录制整段，加载期停在首帧，显式 `play()` 后再计时：

```js
const context = await browser.newContext({
  viewport: { width: 1080, height: 1920 },
  deviceScaleFactor: 1,
  recordVideo: { dir: '/tmp/promo-video', size: { width: 1080, height: 1920 } },
})
const page = await context.newPage()
await page.goto('file:///.../promo.html?capture', { waitUntil: 'load' })
await page.waitForFunction(() => window.__promo?.duration > 0)
const duration = await page.evaluate(() => window.__promo.duration)
// capture 模式默认暂停；不调用 play() 会录到一张静帧
await page.waitForTimeout(5000) // 预滚：给 freezedetect 一个可测的静止段
await page.evaluate(() => window.__promo.play())
await page.waitForFunction(
  (expected) => window.__promo.time >= expected,
  duration,
  { timeout: (duration + 15) * 1000 },
)
await page.waitForTimeout(500) // 末屏品牌多停半秒
await context.close()
```

关键：**动画时钟按真实时间差推进**。如果使用 `dt = Math.min(0.05, delta)`，录制时帧率下降会让成片比音频慢；应放宽到 `0.2` 或直接用 `performance.now()` 计算。

## 5. mux 与压缩

录制文件从 context 创建就开始，开头是加载期与 5 秒预滚（都停在 `?capture` 的首帧）。`TL` 的 `s1.start = 0` 要求成片第 0 秒就是 s1 的第 0 帧，所以**裁切点必须测出来，不能写死 `0.4`**。预滚是刻意留出的 5 秒静止段，用 `freezedetect` 读它的结束点：

```sh
# 只报 4 秒以上的静止段，命中的就是预滚；freeze_end 即 play() 时刻
TRIM=$(ffmpeg -hide_banner -i raw.webm -vf "freezedetect=n=0.003:d=4" -an -f null - 2>&1 \
  | awk '/freeze_end/ { print $NF; exit }')

ffmpeg -y -ss "$TRIM" -i raw.webm -i narration.mp3 \
  -t 66.914 \
  -vf "fps=30,format=yuv420p" \
  -c:v libx264 -preset medium -crf 19 \
  -c:a aac -b:a 192k -ar 48000 \
  -movflags +faststart -shortest out-1080x1920.mp4
```

- 播放后不要留 4 秒以上静止段，否则 `freezedetect` 可能先报后面的段；片尾品牌只停 0.5 秒。
- 加载白屏超过 4 秒时先让页面预热一次，或把预滚加到 8 秒、`d` 改成 7；预滚再长也会被裁掉。
- `-ss` 只作用于 `raw.webm`，音频从 0 开始；先裁视频、再对齐旁白。
- 裁完抽首帧核对：`ffmpeg -y -ss "$TRIM" -i raw.webm -frames:v 1 first.png` 应是 s1 的 `t=0`；差一点就按 0.05–0.1 秒量级微调 `TRIM`，不要靠猜。
- `-t` 与 `narration` 总长一致（`timeline.duration`）；`-shortest` 防止尾部拖黑。
- 1080 宽、30fps、H.264 + AAC 足够手机平台；不要为了小体积降到 720 以下。
- 成片检查：`ffprobe` 的 video/audio duration 一致；抽 4–6 帧看场景是否对得上。

## 6. 常见故障

| 症状 | 原因 | 处理 |
|---|---|---|
| 录到一张静帧 | `?capture` 默认暂停，没调 `play()` | 显式 `window.__promo.play()` 后再等 `duration` |
| 画面比声音慢 | 时间轴用固定 dt，录制掉帧 | 改成真实时间差；放宽 dt 上限 |
| 音画差固定一小段 | `-ss` 写死，或 `freezedetect` 命中了别的静止段 | 用 5 秒预滚 + `d=4` 重测 `TRIM`，抽首帧核对 |
| 声音比画面慢 | mux 时裁了音频开头 | 音频从 0 开始；只裁视频 |
| 最后黑屏 | 末屏也参与淡出 | 最后场景不淡出，或保留品牌帧 |
| 段间爆音 | 静音被裁过头 | 保留 0.1s 以上尾部静音 |
| 字幕越到后面越偏 | 字幕手写时间码 | 从 `timeline.json` 生成 |
| 录制尺寸不对 | `recordVideo.size` 与 viewport 不一致 | 两者都设目标尺寸 |
| 手机上看不清 | 把桌面截图整体缩小 | 重排成大字/裁切卡片，不缩整图 |
