# Agent Note: 落地页统计

Status: implemented

## Problem

落地页（见 [GitHub Pages 落地页](2026-11-20-github-pages-landing.md)）上线后没有测量：Pages 不提供访问统计，Search Console 未验证，SEO 效果与「站点能不能把人送去仓库」都无从判断。仓库 referrers 只有 14 天窗口、按域名聚合，看不到站内点击，也分不出搜索与外部渠道。

## Decision

- **站点事件**：Umami Cloud 无 cookie 脚本，`data-website-id` 直接写在页面里——Website ID 本来就是每个页面公开可见的内容，不做 Actions 变量注入，避免多一个「缺变量即部署失败」的面。
- **限域**：`data-domains="fengshenx.github.io"`，本地预览与镜像站不上报，读数只反映线上。
- **事件**：`outbound-github`（place=nav/hero/install/footer）、`copy-install`（method=hero/web/desktop-cli）、`install-tab`、`zh-readme`、`view-npm`、`play-video`（只记首次）。事件名与 place/method 取值是历史口径，改名等于断档；新增要保留旧名一段时间。
- **SEO**：Search Console 用 URL 前缀属性 + HTML 标记验证（`github.io` 子域改不了 DNS）；`site/sitemap.xml` 提交到 GSC，`loc` 与 canonical 一致。
- **不加 robots.txt**：robots 只认主机根，`github.io/robots.txt` 不归本仓管，子路径那份不会被任何爬虫读取。
- **不上 GA4 / Clarity**：两者都要 cookie 同意与隐私说明页，对单页静态站不值。

## Alternatives considered

- **Actions 变量注入 Website ID**：少写一个公开 UUID，代价是合并瞬间缺变量会让 Pages 部署红一次，还给静态页引入构建步骤。
- **GoatCounter**：同样无 cookie、脚本更小，自定义事件的属性表达与面板弱于 Umami。
- **Cloudflare Web Analytics**：无需账号与 cookie，但不支持自定义事件，量不出「点了 GitHub / 复制了命令」。
- **GA4**：能与 GSC 打通做落地页报告，代价是同意横幅、隐私页与更重的脚本。
- **只靠 GitHub referrers 当转化代理**：零成本，但只有 14 天、按域名聚合、没有 query。

## Consequences

- 读数要拼三个面板：GSC（曝光 / CTR / query）→ Umami（访问与事件）→ GitHub Traffic 与 npm 下载（下游）；漏斗口径写在 `growing/README.md` 的「看数」。
- 广告拦截会漏计一部分；Umami Cloud 免费额度对当前量级足够，超了迁自托管。
- Website ID 或事件名一旦更换，历史曲线断开，改事件要先加新名、观察一段时间再删旧名。
- 收益：落地页从「只能猜」变成可计算的漏斗，发帖前后有可比的基线。

## Testing

本地静态服务 + chromium 实测：hero / nav / footer 的 CTA、三个复制按钮、三个安装 tab、视频 play 全部按预期带参上报；`data-domains` 生效，localhost 只拉脚本、不发 collect；页面 0 console error / 0 pageerror，1440 与 390 两档无横向溢出；`sitemap.xml` 过 XML 解析且与 canonical 一致。
