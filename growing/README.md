# growing

增长相关内容的沉淀目录：每次宣传片、封面、文案、旁白和复盘都记在这里。

**Git 只存文本、源文件和索引；视频、音频、standalone HTML、全尺寸封面放阿里云 OSS。** 规则、bucket、公开边界与上传方法只有一处归属：[`AGENTS.md`](AGENTS.md)。

## 索引

| 日期 | 主题 | 形态 | 入口 |
|---|---|---|---|
| 2026-11-16 | 我同时开发 20 个需求的经验 | 竖屏 1080×1920 / 102.9s / 60fps + 9:16 & 3:4 封面 | [案例](2026-11-16-leader-agent-promo/README.md) |
| 2026-11-19 | 项目介绍 HTML deck | 8 页 16:9 网页幻灯片 | [案例](2026-11-19-project-intro/README.md) |

## 看数

- **站点流量与事件**：Umami Cloud → Websites → `fengshenx.github.io`（无 cookie，只收线上域名）。
- **SEO**：Search Console 前缀 `https://fengshenx.github.io/dsh-leader-agent/`；提交 sitemap `https://fengshenx.github.io/dsh-leader-agent/sitemap.xml`。
- **仓库**：Insights → Traffic（views / clones / referrers，14 天滚动，过期不补）。
- **安装**：`https://api.npmjs.org/downloads/point/last-week/dsh-leader-agent`；star 曲线用 star-history。

漏斗：曝光（GSC）→ 访问（Umami）→ `outbound-github` / `copy-install` → star / clone → npm 周下载。口径与取舍见[笔记](../.agents/notes/implemented/process/2026-11-20-site-analytics.md)。

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

## 新案例

建目录 → 写 `README.md` / `script.md` / `storyboard.md` / `timeline.json` → 源文件放 `source/` → 按 [`AGENTS.md`](AGENTS.md#新增案例) 上传并生成 `media.json` → 更新本索引。

不上 LFS、不建 Release；媒体只走 OSS。
