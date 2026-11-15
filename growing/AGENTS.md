# growing 工作规则

本目录是增长资产的**索引与源文件库**，不是二进制仓库。视频、音频、standalone、全尺寸图一律走 OSS。

## 硬规则

1. **Git 里只放文本、源 HTML、小素材、索引和 ≤200 KB 的预览图。** 单个源素材超过 2 MB、或 `source/` 总量超过 5 MB，就上传 OSS，源 HTML 改用远程地址。
2. **禁止入库的扩展名**：`.mp4`、`.mov`、`.mp3`、`.wav`、`.zip`、`standalone.html`。`.gitignore` 已拦截；不要用 `git add -f` 绕过。
3. **每个案例必须有 `media.json`**，记录每个 OSS 资产的 `kind`、`key`、`url`、`bytes`、`sha256`、`contentType`。
4. **OSS key 不可覆盖。** 重做视频/封面/HTML 时使用新 key（`-v2`、日期或短哈希），并在 `media.json` 追加；不要静默替换已有对象。
5. **凭据不落库。** 使用本机已配置的 `aliyun` CLI（或 `ossutil`）；不把 AccessKey、STS token、签名 URL 写进 Markdown、脚本或日志。
6. **只放可公开的增长素材。** bucket 是公共读；不要上传用户数据、内部地址、未脱敏截图或密钥。
7. **不用 LFS，不建 Release。** `growing/` 的媒体只走 OSS；Release 只服务真正的软件版本。

## Bucket 与目录

- Bucket：`dsh-agent-leader`
- Region：`oss-cn-beijing`
- Endpoint：`oss-cn-beijing.aliyuncs.com`
- ACL：bucket `public-read`；**Block Public Access 已关闭**（否则匿名读会 403）。
- 访问前缀：`https://dsh-agent-leader.oss-cn-beijing.aliyuncs.com/growing/`
- 对象 key：`growing/<YYYY-MM-DD-slug>/<kind>/<filename>`

固定种类：

```text
growing/<case>/video/      # mp4
growing/<case>/audio/      # mp3
growing/<case>/html/       # standalone
growing/<case>/covers/     # 9:16、3:4 全尺寸
```

不要用日期当 key 的版本号后又覆盖同一天；同日重做加 `-v2`。

## 上传

```sh
# 上传；脚本会拒绝已存在的 key，并打印 bytes/sha256
./growing/scripts/upload-media.sh \
  .dev/promo/video/demo.mp4 \
  2026-11-16-leader-agent-promo/video/demo-1080x1920.mp4 \
  video/mp4
```

脚本只是 `aliyun oss cp` 的薄封装：

- 校验文件存在、目标 key 不存在；
- 带 `--meta "Content-Type:<type>#Cache-Control:public,max-age=..."`；
- **不要加对象级 `--acl public-read`**：当前账号禁止 Put public object acl，bucket 级 public-read 已经够用；
- 上传后打印 `bytes` 与 `sha256`，直接填进 `media.json`。

`ossutil` v2 也可以手动上传，但同样不要覆盖旧 key。上传前先：

```sh
aliyun oss stat oss://dsh-agent-leader/growing/<case>/<kind>/<file> \
  -e oss-cn-beijing.aliyuncs.com
```

返回 404 才允许上传；200 就换 key。

## Content-Type

| 文件 | Content-Type | Cache-Control |
|---|---|---|
| mp4 | `video/mp4` | `public,max-age=31536000,immutable` |
| mp3 | `audio/mpeg` | 同上 |
| png/jpg | `image/png` / `image/jpeg` | 同上 |
| html | `text/html; charset=utf-8` | `public,max-age=3600` |

HTML 的 Content-Type 错了会变成下载而不是打开；上传后必须用 `curl -I` 验证 200 和 `text/html`。

注意：**OSS 标准域名对 HTML 会强制下载**（`Content-Disposition: attachment` + `x-oss-force-download: true`），这不是 Content-Type 错误；要在线直接打开必须给 bucket 绑自定义域名。归档时按“下载后打开”记录，不要承诺 `oss-cn-beijing.aliyuncs.com` 链接能直接渲染。

## 新增案例

1. 新建 `growing/<YYYY-MM-DD-slug>/`，写 `README.md`：一句话命题、受众、结果、这次学到什么。
2. 写 `script.md`、`storyboard.md`；TTS 后生成 `timeline.json`，保持 `speech/lead/tail/duration`。
3. 可编辑源 HTML 和小素材放 `source/`；如果 `source/` 超过 5 MB，素材改远程 URL。
4. 视频/音频/standalone/大封面按上面的 key 规则上传，生成 `media.json`。
5. 生成 `preview.jpg`（≤200 KB）供 README 预览；9:16 封面可用视频 S0 首帧（第一帧就是完整封面），3:4 单独排版，不要拿中间帧当封面。
6. 更新 [`README.md`](README.md) 索引。
7. 运行：

```sh
npm run check
```

再逐个 `curl -I` 验证 `media.json` 里的 URL 是 200，Content-Type 正确。

## 与制作方法的关系

本目录只负责**归档与索引**，不复制制作方法正文。具体方法看：

- [promo-video](../../.agents/skills/promo-video/SKILL.md)：分镜、时间轴、录制与合成。
- [doubao-tts](../../.agents/skills/doubao-tts/SKILL.md)：旁白合成、测长、补静音与响度。
- [promo-stills](../../.agents/skills/promo-stills/SKILL.md)：封面与标题图。

案例里的 `README.md` / `storyboard.md` / `script.md` 只记录这次的取舍和结果。
