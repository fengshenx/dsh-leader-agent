# growing

增长相关内容的沉淀目录：每次宣传片、封面、文案、旁白和复盘都记在这里。

**Git 只存文本、源文件和索引；视频、音频、standalone HTML、全尺寸封面放阿里云 OSS。**

## 索引

| 日期 | 主题 | 形态 | 入口 |
|---|---|---|---|
| 2026-11-16 | 我的 20 个并行任务，终于不用一个个追了 | 竖屏 1080×1920 / 66.9s + 9:16 & 3:4 封面 | [案例](2026-11-16-leader-agent-promo/README.md) |

## 目录

```text
growing/
  AGENTS.md                         # 本目录的工作规则（被动注入）
  README.md                         # 本索引
  scripts/
    upload-media.sh                 # OSS 上传：不可覆盖 key，自动打 Content-Type
  <YYYY-MM-DD-slug>/
    README.md                       # 案例：命题、受众、结果、复盘
    script.md                       # 旁白全文与分段
    storyboard.md                   # 分镜
    timeline.json                   # 音频实测时长与场景起点
    media.json                      # OSS URL / bytes / sha256 / contentType
    preview.jpg                     # 小预览，≤200 KB
    source/
      promo.html                    # 可编辑源文件
      assets/                       # 小素材；大图走 OSS
    text/
      narration.srt
```

## 媒体位置

- Bucket：`dsh-agent-leader`（`oss-cn-beijing`，公共读）
- 前缀：`growing/<YYYY-MM-DD-slug>/`
- 只允许本项目的增长素材；不要放密钥、用户数据或无关备份。
- key 不可覆盖；重做用 `-v2` 等新 key，并在 `media.json` 追加记录。

## 新案例

1. 建 `growing/<YYYY-MM-DD-slug>/`，先写 `README.md` 的一句话命题、受众和预期结果。
2. 写 `script.md` / `storyboard.md`，跑 TTS 后生成 `timeline.json`。
3. 源 HTML 与小素材放 `source/`；视频/音频/standalone/大图用 [`scripts/upload-media.sh`](scripts/upload-media.sh) 上传 OSS。
4. 生成 `media.json`，记录 URL、字节数、sha256、Content-Type。
5. 更新本索引和案例 README。
6. 不上 LFS、不建 Release；媒体只走 OSS。

详细约束见 [`AGENTS.md`](AGENTS.md)。
