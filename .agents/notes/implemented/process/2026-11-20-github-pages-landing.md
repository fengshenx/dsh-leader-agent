# Agent Note: GitHub Pages 落地页

Status: implemented

## Problem

检索入口（topics、npm keywords、生态目录收录）已占，但 GitHub 仓库页对搜索引擎不友好：游客有 interstitial、没有独立可索引的 URL，泛关键词（multi-agent orchestration 等）搜不到本仓。缺一个能被 Google 收录并积累权重的落地页。

## Decision

`site/index.html` 单文件静态页（深色极简科技风、内联 CSS，原生 JS 只做安装方式 tab 切换与命令复制按钮）+ `site/logo-mark.svg` 独立品牌标/favicon，GitHub Actions 部署到 Pages（`build_type=workflow`；仓库 Settings → Pages 的 Source 需设为 GitHub Actions，合并后配置）。同步重绘 README 浅/深色中英文 Logo（`docs/assets/readme/logo-*.svg`）。页面媒体来源按 OSS 强制下载边界选：OSS 对 HTML/PNG 带 `Content-Disposition: attachment`，所以页面内图片与 og:image 走 GitHub raw；mp4 无强制下载头，英文宣传视频（`promo-en-1080x1920-v2.mp4`，豆包 TTS 2.0 英文旁白）直接嵌 OSS URL。

## Alternatives considered

- **gh-pages 分支放产物**：多一条构建/推送链，而产物完全可由源码再生成，不值。
- **Jekyll / ReadTheDocs**：单页纯静态，引工具链只多约束。
- **Pages 源指向 `docs/`**：会把全部开发文档当站点发布，`docs/` 还被迫混入 `index.html`，与文档分层冲突。

## Consequences

- 域名是 `fengshenx.github.io/dsh-leader-agent/`；canonical 与 og:url 已写死，将来换自定义域名要同步改。
- `site/` 不在 oxlint / 文档预算 / 覆盖率门禁范围（非 JS、非受管 Markdown），改动靠部署后人工核对。
- 页面引用 main 分支的 raw 图片与 OSS 视频，视频出新版本时要更新 `site/index.html` 里的 URL。

收益：一个可被搜索引擎独立收录、可在外发渠道直接贴的稳定入口。

## Testing

部署后 `curl -I` 验 200，再验 canonical / JSON-LD / og 标签齐全。
