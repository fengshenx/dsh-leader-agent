#!/usr/bin/env node
/**
 * 豆包语音合成 2.0 的最小客户端。
 *
 * 只负责一次合成：把文本发给 V3 单向流式 HTTP 接口，拼出 NDJSON 里的音频分片，
 * 写入文件。分段、补静音、响度与时间轴由调用方负责（见 SKILL.md）。
 *
 * 用法：
 *   # 先让 DOUBAO_TTS_KEY 存在于环境中
 *   node tts.mjs --text "..." --out /tmp/voice.mp3
 *   node tts.mjs --help
 *
 * 凭据只从环境变量读：DOUBAO_TTS_KEY 或 DOUBAO_TTS_API_KEY。脚本不打印它。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const DEFAULT_SPEAKER = 'zh_male_jieshuoxiaoming_uranus_bigtts'
const DEFAULT_RESOURCE_ID = 'seed-tts-2.0'
const DEFAULT_SAMPLE_RATE = 24000
const VALID_FORMATS = new Set(['mp3', 'wav', 'pcm', 'ogg_opus'])

const HELP = `豆包 TTS 2.0

用法:
  node tts.mjs --text "要读的文本" --out /tmp/voice.mp3 [选项]
  node tts.mjs --text-file script.txt --out /tmp/voice.mp3 [选项]

凭据:
  DOUBAO_TTS_KEY        新版控制台 API Key（优先）
  DOUBAO_TTS_API_KEY    同上，兼容别名
  只从环境变量读取，不写入任何文件。

选项:
  --text <text>         待合成文本；与 --text-file 二选一
  --text-file <path>    UTF-8 文本文件
  --out <path>          输出文件（必填）
  --speaker <id>        音色，默认 ${DEFAULT_SPEAKER}
  --rate <n>            语速 -50..100，默认 0；-5 到 -10 更慢
  --loudness <n>        音量 -50..100，默认 0
  --format <name>       mp3 / wav / pcm / ogg_opus，默认 mp3
  --sample-rate <n>     采样率，默认 ${DEFAULT_SAMPLE_RATE}
  --resource-id <id>    模型版本，默认 ${DEFAULT_RESOURCE_ID}
  --endpoint <url>      仅本地 mock/可信代理时覆盖；Key 会发到该地址
  --uid <id>            请求里的 user.uid，默认 dsh-leader-agent
  --help                显示本帮助

安全:
  --endpoint 覆盖会把 X-Api-Key 发到指定地址。只对本地 mock 或可信代理使用；
  指向其他地址时脚本会在 stderr 打印警告。

示例:
  source ~/.zshrc
  node .agents/skills/doubao-tts/scripts/tts.mjs \\
    --text "同时跑五个任务，是什么感觉？" \\
    --out /tmp/vo-01.mp3 --rate -5
`

const VALUE_OPTIONS = [
  'text', 'text-file', 'out', 'speaker', 'rate', 'loudness',
  'format', 'sample-rate', 'resource-id', 'endpoint', 'uid',
]
const FLAG_OPTIONS = ['help']
const OPTION_SUMMARY = VALUE_OPTIONS.map((name) => `--${name}`).concat('--help').join(' ')

/**
 * 读取命令行参数；只接受白名单里的选项。
 *
 * 拼错的选项（`--speeker`）如果静默进表，会按默认音色合成却不报错；所以未知键直接失败。
 * 位置参数同样拒绝，且不回显原值——误把密钥当参数传进来时，错误信息不能把它带出去。
 *
 * @param {string[]} argv - 不含 node 与脚本路径的参数
 * @returns {Record<string, string | boolean>} 参数表
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const values = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h') {
      values.help = true
      continue
    }
    if (!arg.startsWith('--')) {
      throw new Error(`第 ${i + 1} 个参数不是 -- 选项；位置参数不支持（可用参数：${OPTION_SUMMARY}）`)
    }
    const key = arg.slice(2)
    if (FLAG_OPTIONS.includes(key)) {
      values[key] = true
      continue
    }
    if (!VALUE_OPTIONS.includes(key)) {
      throw new Error(`未知参数：${arg}；可用参数：${OPTION_SUMMARY}`)
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`参数 --${key} 缺少值`)
    values[key] = next
    i += 1
  }
  return values
}

/**
 * 按整数区间校验参数。
 *
 * @param {unknown} value - 原始值
 * @param {string} name - 参数名
 * @param {number} min - 下界
 * @param {number} max - 上界
 * @returns {number} 校验后的整数
 */
function intInRange(value, name, min, max) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`--${name} 必须是 ${min}..${max} 的整数`)
  }
  return number
}

/**
 * 把响应行解析成音频分片；兼容 NDJSON 与误配成 SSE 的代理。
 *
 * @param {string} raw - 响应正文
 * @returns {Buffer[]} 音频分片
 */
function collectAudio(raw) {
  const chunks = []
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '')
  for (const rawLine of lines) {
    const line = rawLine.startsWith('data:') ? rawLine.slice(5).trim() : rawLine
    if (line === '' || line === '[DONE]') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error(`响应不是合法 JSON 行：${line.slice(0, 120)}`)
    }
    const code = Number(event.code)
    if (code === 20000000) break
    if (code !== 0) {
      throw new Error(`TTS 返回 code=${event.code} message=${event.message ?? '(none)'}`)
    }
    if (typeof event.data === 'string' && event.data !== '') {
      chunks.push(Buffer.from(event.data, 'base64'))
    }
  }
  if (chunks.length === 0) throw new Error('响应里没有音频分片（检查音色、资源 ID 与文本）')
  return chunks
}

/**
 * 校验 endpoint；非默认地址时在 stderr 警告，因为 Key 会随请求头发出去。
 *
 * @param {string} endpoint - 命令行传入或默认地址
 * @returns {URL} 解析后的 URL
 */
function parseEndpoint(endpoint) {
  let url
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error('--endpoint 不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--endpoint 只支持 http(s) URL')
  }
  if (url.href !== DEFAULT_ENDPOINT) {
    process.stderr.write(
      `警告：--endpoint 指向 ${url.origin}，API Key 会发送到该地址；只用于本地 mock 或可信代理。\n`,
    )
  }
  return url
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    process.stdout.write(HELP)
    return
  }

  const key = (process.env.DOUBAO_TTS_KEY ?? process.env.DOUBAO_TTS_API_KEY ?? '').trim()
  if (key === '') {
    throw new Error('缺少 DOUBAO_TTS_KEY（或 DOUBAO_TTS_API_KEY）；请先在 shell 里设置环境变量')
  }

  const out = typeof args.out === 'string' ? args.out : ''
  if (out === '') throw new Error('缺少 --out')
  if (args.text !== undefined && args['text-file'] !== undefined) {
    throw new Error('--text 与 --text-file 只能二选一')
  }
  const text = args.text !== undefined
    ? String(args.text)
    : args['text-file'] !== undefined
      ? await readFile(String(args['text-file']), 'utf8')
      : ''
  if (text.trim() === '') throw new Error('文本为空；传 --text 或 --text-file')

  const format = typeof args.format === 'string' ? args.format : 'mp3'
  if (!VALID_FORMATS.has(format)) {
    throw new Error(`--format 不支持，可用：${[...VALID_FORMATS].join(' / ')}`)
  }
  const sampleRate = args['sample-rate'] === undefined
    ? DEFAULT_SAMPLE_RATE
    : intInRange(args['sample-rate'], 'sample-rate', 8000, 48000)
  const rate = args.rate === undefined ? 0 : intInRange(args.rate, 'rate', -50, 100)
  const loudness = args.loudness === undefined ? 0 : intInRange(args.loudness, 'loudness', -50, 100)
  const speaker = typeof args.speaker === 'string' ? args.speaker : DEFAULT_SPEAKER
  const resourceId = typeof args['resource-id'] === 'string' ? args['resource-id'] : DEFAULT_RESOURCE_ID
  const endpoint = typeof args.endpoint === 'string' ? args.endpoint : DEFAULT_ENDPOINT
  const uid = typeof args.uid === 'string' ? args.uid : 'dsh-leader-agent'
  const endpointUrl = parseEndpoint(endpoint)

  const payload = {
    user: { uid },
    req_params: {
      text,
      speaker,
      audio_params: {
        format,
        sample_rate: sampleRate,
        speech_rate: rate,
        loudness_rate: loudness,
      },
    },
  }

  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': key,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`TTS HTTP ${response.status}：${raw.slice(0, 300)}`)
  }
  const audio = Buffer.concat(collectAudio(raw))
  await writeFile(out, audio)
  process.stdout.write(`已写入 ${out}（${audio.length} bytes，speaker=${speaker}，rate=${rate}）\n`)
}

main().catch((error) => {
  process.stderr.write(`tts: ${error.message}\n`)
  process.exit(1)
})
