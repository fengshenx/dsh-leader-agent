# growing 工作规则

本目录是增长资产的**索引与源文件库**，不是二进制仓库。视频、音频、standalone、全尺寸封面一律走 OSS。

**本文件是这些事实的唯一归属**：[README](README.md) 只做索引，案例文档只记本次取舍，都不复述规则。

## 硬规则

1. **Git 里只放文本、源 HTML、小素材、索引和 ≤200 KB 的预览图。** 源素材入库上限：单文件 ≤2 MB、`source/` 合计 ≤5 MB；超过就上传 OSS，源 HTML 改用远程地址。**全尺寸封面与最终交付图一律在 OSS**（按像素是「大图」，按规则不看字节数）。
2. **禁止入库的扩展名**：`.mp4`、`.mov`、`.webm`、`.m4v`、`.mp3`、`.wav`、`.m4a`、`.zip`，以及 `*standalone*.html`（单文件 HTML 是发布产物）。`.gitignore` 已拦截；不要用 `git add -f` 绕过。
3. **每个案例必须有 `media.json`**：每个资产记录 `kind`、`key`、`url`、`bytes`、`sha256`、`contentType`。共用字段（bucket / region / prefix / baseUrl）放顶层，资产按版本分组到 `versions[]`，`fps` / `durationSeconds` 写在各自版本组里——v1 是 30fps、v2 是 60fps，放顶层会被读成同一份。
4. **OSS key 不可覆盖。** 重做视频/封面/HTML 用新 key（`-v2`、日期或短哈希），在 `media.json` 追加版本组；不要静默替换已有对象。
5. **禁止并发上传同一 key。** `upload-media.sh` 的 `stat → cp` **不是原子操作**：两个进程都会 stat 到 404 然后各自上传，`--force` 下后写覆盖先写。正常单次串行调用可靠；并发场景不加锁（成本不值），靠这条纪律避免。
6. **凭据不落库。** 只用本机已配置的 `aliyun` CLI 凭据；不把 AccessKey、STS token、签名 URL 写进 Markdown、脚本或日志。脚本本身不读、不写、不打印凭据。
7. **只放可公开的增长素材。** bucket 公共读，上传即公开且撤不回；上传前按下面的[检查清单](#上传前检查清单)逐项过。
8. **不用 LFS，不建 Release。** `growing/` 的媒体只走 OSS；Release 只服务真正的软件版本。

## Bucket 与目录

- Bucket：`dsh-agent-leader`；Region：`oss-cn-beijing`；Endpoint：`oss-cn-beijing.aliyuncs.com`
- ACL：bucket `public-read`；**Block Public Access 已关闭**（否则匿名读会 403）。匿名 list 仍 403。
- 访问前缀：`https://dsh-agent-leader.oss-cn-beijing.aliyuncs.com/growing/`
- 对象 key：`growing/<YYYY-MM-DD-slug>/<kind>/<filename>`

固定 `kind`，与 OSS 目录同名，`media.json` 只用这四个值：

```text
video    # mp4
audio    # mp3
html     # standalone
covers   # 9:16、3:4 全尺寸封面
```

`media.json` 的 `key` **省略前缀、是 prefix-relative**（写 `video/promo-v2.mp4`，不写 `growing/<case>/video/...`）；完整地址看 `url`。

## 上传

```sh
./growing/scripts/upload-media.sh \
  .dev/promo/video/demo.mp4 \
  2026-11-16-leader-agent-promo/video/demo-1080x1920.mp4 \
  video/mp4
```

脚本只是 `aliyun oss cp` 的薄封装：

- 先 `aliyun oss stat`，只有 404 才继续；已存在退出 1，网络/权限错误直接中止；
- 带 `--meta "Content-Type:<type>#Cache-Control:public,max-age=..."`；
- **不要加对象级 `--acl public-read`**：当前账号禁止 Put public object acl，bucket 级 public-read 已经够用；
- 上传后打印 `bytes`、`sha256`、`contentType`、`cacheControl`，直接填进 `media.json`。

**一次只跑一个上传进程**，同一 key 尤其不行（硬规则 5）。`ossutil` v2 也可手动上传：同样先 `aliyun oss stat oss://dsh-agent-leader/growing/<case>/<kind>/<file>`，404 才传、200 就换 key，同样不要覆盖。

## Content-Type

| 文件 | Content-Type | Cache-Control |
|---|---|---|
| mp4 | `video/mp4` | `public,max-age=31536000,immutable` |
| mp3 | `audio/mpeg` | 同上 |
| png/jpg | `image/png` / `image/jpeg` | 同上 |
| html | `text/html; charset=utf-8` | `public,max-age=3600` |

HTML 的 Content-Type 错了会变成下载而不是打开；上传后必须用 `curl -I` 验证 200 和 `text/html`。

**OSS 标准域名强制下载，实测覆盖 HTML 与封面 PNG**：两者都带 `Content-Disposition: attachment` + `x-oss-force-download: true`，video/audio 没有。这不是 Content-Type 错误，是 OSS 的安全策略。要在线直接渲染必须给 bucket 绑自定义域名（本仓未配置，未实测）；归档一律按「下载后打开」记录，不要承诺 `oss-cn-beijing.aliyuncs.com` 链接能直接预览。

## 上传前检查清单

public-read 意味着**上传即公开、Git 历史里也撤不回**，所以逐项人工核对，不靠「看起来没问题」：

- [ ] **品牌名**：只出现已公开发布的品牌与已上线产品名。
- [ ] **内部项目名 / 代号**：截图、字幕、旁白里的项目、仓库、分支、PR 与 issue 号必须是演示数据。
- [ ] **未发布模型名**：不出现内部模型代号或未发布的版本号。
- [ ] **真实人名 / 邮箱**：会话名、卡片标题、汇报内容里的一律换成假数据。
- [ ] **本机路径**：`/Users/<name>`、`/home/<name>`、`C:\Users\...`、主机名、内网 IP 一处都不能有。
- [ ] **真实客户数据**：不收真实客户/用户数据，脱敏的也不收（脱敏可能可逆）。
- [ ] **凭据**：无 AccessKey、STS token、签名 URL、cookie、私钥。
- [ ] **兜底扫描**：`grep -rniE '/Users/|/home/|LTAI[0-9A-Za-z]+|OSSAccessKeyId|Signature=|@[a-z0-9.-]+\.[a-z]{2,}' growing/`，命中项逐条确认。
- [ ] **第二人复核**：开 PR 前让另一个人按本清单看截图与 standalone HTML，画面里的小字要放大看。

已确认的先例：**`2026-11-16` 宣发案例截图里的项目名与模型名是演示数据，可公开**。这个结论只对那批素材成立，新案例要重新走清单。

## 新增案例

1. 新建 `growing/<YYYY-MM-DD-slug>/`，写 `README.md`：一句话命题、受众、结果、这次学到什么。
2. 写 `script.md`、`storyboard.md`；TTS 后生成 `timeline.json`，保持 `speech/lead/tail/duration`。
3. 可编辑源 HTML 和小素材放 `source/`；超过上面的入库上限就改远程 URL。视频/音频/standalone/封面按 key 规则串行上传，按版本分组生成 `media.json`。
4. 生成 `preview.jpg`（≤200 KB）供 README 预览；9:16 封面用视频 S0 首帧（第一帧就是完整封面），3:4 单独排版，不要拿中间帧当封面。
5. 更新 [`README.md`](README.md) 索引，跑：

```sh
npm run check
```

`npm run check` 的文档预算门禁已覆盖 `growing/**/*.md`，漏登记或超限都会红。

再逐个 `curl -I` 验证 `media.json` 里的 URL：200、Content-Type 正确、bytes 与记录一致。

## 与制作方法的关系

本目录只负责**归档与索引**，不复制制作方法正文。具体方法看：

- [promo-video](../.agents/skills/promo-video/SKILL.md)：分镜、时间轴、录制与合成。
- [doubao-tts](../.agents/skills/doubao-tts/SKILL.md)：旁白合成、测长、补静音与响度。
- [promo-stills](../.agents/skills/promo-stills/SKILL.md)：封面与标题图。

案例里的 `README.md` / `storyboard.md` / `script.md` 只记录这次的取舍和结果。
