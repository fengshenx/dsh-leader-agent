# 时间轴与录制

这条流水线只有一个真源：**旁白的实测时长**。动画、字幕、场景起止都从它算出来。

## 1. 分段合成

按分镜表把旁白拆成 `s1..s6`，每段单独合成：

```sh
source ~/.zshrc

node .agents/skills/doubao-tts/scripts/tts.mjs \
  --text "同时跑五个任务，是什么感觉？这个等你确认，那个又报错。" \
  --out .dev/promo/audio/s1.mp3 \
  --speaker zh_male_jieshuoxiaoming_uranus_bigtts --rate -5
```

每段生成后立刻测长：

```sh
ffprobe -v error -show_entries format=duration \
  -of default=nw=1:nk=1 .dev/promo/audio/s1.mp3
```

把结果写进 `timeline.json`，不要只记在脑子里：

```json
{
  "segments": [
    { "key": "s1", "speech": 7.608, "lead": 0.35, "tail": 1.0, "duration": 8.958 }
  ],
  "starts": { "s1": 0 },
  "duration": 66.914
}
```

`duration = lead + speech + tail`；场景起点是前面所有 `duration` 的累加。

## 2. 补静音并拼接

每段前补 `lead`、后补到目标时长，再拼成一条。用 WAV 中间态，避免 MP3 编码延迟累积：

```sh
# 例：lead=0.35s，目标 8.958s
ffmpeg -y -i .dev/promo/audio/s1.mp3 \
  -af "adelay=350:all=1,apad" -t 8.958 \
  -ar 48000 -ac 1 -c:a pcm_s16le .dev/promo/audio/s1.wav

# concat.txt 里写绝对路径，避免 ffmpeg 相对 concat 文件目录解析
ffmpeg -y -f concat -safe 0 -i concat.txt \
  -c:a pcm_s16le .dev/promo/audio/narration.wav

ffmpeg -y -i .dev/promo/audio/narration.wav \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
  -ar 48000 -c:a libmp3lame -b:a 192k .dev/promo/audio/narration.mp3
```

检查：

```sh
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 narration.mp3
ffmpeg -hide_banner -nostats -i narration.mp3 -af volumedetect -f null -
```

期望：总长等于 `timeline.duration`；平均约 −17 dB、峰值低于 0 dB；段间静音约 0.8–1.5 秒，不要出现 3 秒以上的死区。

## 3. 时间轴

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

如果改了一句旁白，重新测长并重算所有后续起点；不要只改一个场景的 `end` 而造成重叠。

## 4. HTML 契约

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
- 提供 `?capture&t=<seconds>`：隐藏 HUD/控制/重播层，`seek(t)` 后暂停。
- 暴露一个只读调试对象：`window.__promo = { duration, seek, play, pause, time, playing }`。
- 录制模式下不要显示光标、hover 态或浏览器滚动条。

## 5. 录制

Playwright 录制整段，再裁掉加载器：

```js
const context = await browser.newContext({
  viewport: { width: 1080, height: 1920 },
  deviceScaleFactor: 1,
  recordVideo: { dir: '/tmp/promo-video', size: { width: 1080, height: 1920 } },
})
const page = await context.newPage()
await page.goto('file:///.../promo.html?capture', { waitUntil: 'load' })
await page.waitForFunction(() => window.__promo)
// 等页面稳定后再计时；此处等待整片时长 + 1–2 秒
await page.waitForTimeout(68_000)
await context.close()
```

关键：**动画时钟按真实时间差推进**。如果使用 `dt = Math.min(0.05, delta)`，录制时帧率下降会让成片比音频慢；应放宽到 `0.2` 或直接用 `performance.now()` 计算。

## 6. mux 与压缩

```sh
ffmpeg -y -ss 0.4 -i raw.webm -i narration.mp3 \
  -t 66.914 \
  -vf "fps=30,format=yuv420p" \
  -c:v libx264 -preset medium -crf 19 \
  -c:a aac -b:a 192k -ar 48000 \
  -movflags +faststart -shortest out-1080x1920.mp4
```

- `-ss` 是裁掉加载器/首帧等待；必须小于第一个场景开始前的空白。
- `-t` 与 `narration` 总长一致；`-shortest` 防止尾部拖黑。
- 1080 宽、30fps、H.264 + AAC 足够手机平台；不要为了小体积降到 720 以下。
- 成片检查：`ffprobe` 的 video/audio duration 一致；抽 4–6 帧看场景是否对得上。

## 7. 常见故障

| 症状 | 原因 | 处理 |
|---|---|---|
| 画面比声音慢 | 时间轴用固定 dt，录制掉帧 | 改成真实时间差；放宽 dt 上限 |
| 声音比画面慢 | mux 时裁了音频开头 | 音频从 0 开始；只裁视频 |
| 最后黑屏 | 末屏也参与淡出 | 最后场景不淡出，或保留品牌帧 |
| 段间爆音 | 静音被裁过头 | 保留 0.1s 以上尾部静音 |
| 字幕越到后面越偏 | 字幕手写时间码 | 从 `timeline.json` 生成 |
| 录制尺寸不对 | `recordVideo.size` 与 viewport 不一致 | 两者都设目标尺寸 |
| 手机上看不清 | 把桌面截图整体缩小 | 重排成大字/裁切卡片，不缩整图 |
