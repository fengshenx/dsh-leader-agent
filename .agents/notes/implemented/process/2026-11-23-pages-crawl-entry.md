# Agent Note: Pages 的抓取入口与 404

Status: implemented

## Problem

落地页只有 Search Console 里手工提交的 sitemap，没有 `site/robots.txt`，也没有 `site/404.html`。实测该项目路径下未命中的 URL 会在 404 与 503（GitHub 的 Varnish 错误页）之间间歇抖动，而 `/robots.txt` 本身就是未命中路径：Googlebot 把 robots.txt 的 5xx 当成站点暂时不可达，会压低甚至暂停抓取。新站又没有 followed 外链（README 里的站点链接实测带 `rel="nofollow"`），抓取预算本来就紧。

## Decision

- `site/robots.txt`：`Allow: /` 加一行 `Sitemap:` 指向线上 sitemap，给爬虫一个不依赖 Search Console 的发现入口。
- `site/404.html`：Pages 用根目录这张页面替换未知路径的响应体，**HTTP 状态仍是 404**，页面没有 refresh / JS 软跳转，不再走后端的兜底；带 `noindex`，只回链首页与仓库，不加载分析脚本——错误路径不该计入站点流量。

## Alternatives considered

- **只靠 Search Console 提交 sitemap**：能收录首页，但 robots.txt 仍落在会抖动的未命中路径上，新站也少一个发现入口。
- **404 页挂 Umami**：错误路径会被记成 pageview，污染「访问 → 出站」的漏斗口径。
- **换自定义域名**：能绕开 github.io 的抓取预算与 503 兜底，但需要域名、DNS 与 CNAME 记录，当前阶段成本不匹配。
- **`package.json` 的 `homepage` 指向落地页**：npm 包页本来就渲染 README，homepage 再指过去会把「文档入口」换成营销页；README 顶部已有 Website 链接，保留指向 README。

## Consequences

- sitemap 有两个发现入口（robots.txt 与 Search Console 提交）；新增页面要同时更新 `site/sitemap.xml`。
- 404 页与首页视觉一致但样式各自内联（`site/` 没有构建链），改品牌色要改两处。
- `site/` 没有构建链，只有静态契约测试（`tests/site-crawl.test.js`，随 `npm run check` 执行）：robots 的放行与 sitemap 指向、sitemap 的 loc 与 canonical、404 的 noindex 与无软跳转；线上状态码仍靠部署后核对。

收益：robots.txt 与 404 都由产物直接提供，爬虫不会再把一次未命中读成 5xx。

## Testing

部署后验 `robots.txt` 与 `sitemap.xml` 均 200、未命中路径返回 404（只替换响应体，状态仍是 404，页面无 refresh/JS 软跳转）且是本站 404 页；收录侧读数看 Search Console 的 robots.txt 抓取与 sitemap 状态、Bing Webmaster 的 URL 检查。
