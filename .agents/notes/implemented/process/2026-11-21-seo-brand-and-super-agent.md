# Agent Note: 落地页关键词（品牌写法与 Super-agent 边界）

Status: implemented

## Problem

搜 `dsh leader agent` 时，一次人工查询里排在最前的是 `github.com/.../blob/main/docs/development.md` 而不是落地页（只是当时的一次观察）：GitHub blob 页能独立收录（没有 canonical、没有 robots meta），title 与 description 都带仓库名，而落地页上线一天、零外链、还没被收录。同时落地页对 DeepSeek Harness 团队的研究原型只字未提——既可能被误认成 DeepSeek 官方产品，也白丢「super agent 对比 / 替代」这类长尾。

## Decision

- **品牌词写准**：title / og:title / twitter:title 与 hero 首段出现不带连字符的 `dsh leader agent`；JSON-LD 用 `alternateName` 记录同一产品的另一种写法。h1 不动——主张与视觉都不换。
- **Super-agent 只进内容层**：落地页加 `#faq`（一个 h2 问题 + 三条 Q&A + FAQPage JSON-LD），其中一条是 `Super-agent vs. leader/worker orchestration` 的对比；研究原型的链接与「不是 DeepSeek 官方产品」的声明写在 FAQ 里。title / `alternateName` / npm keywords 一律不写 Super-agent。
- **README 的设计取舍一条改成带链接的对比**：仓库页权重高于落地页，先让它吃到词，锚文本指到 `#faq`。
- 不写 `<meta name="keywords">`：Google 不读，Bing 当垃圾信号。
- 顺手给 `.section` 加 `scroll-margin-top: 80px`：新的 `#faq` 导航跳转时 h2 会被吸顶 header 压住，原有锚点本来也有同样问题。

## Alternatives considered

- **把 Super-agent 放进 title 抢 head 词**：研究原型 24k 星、一批新闻站占位，抢不到；搜这个词的人预期是官方产品，点进来发现是第三方插件会立刻跳出。
- **单独开一个对比页**：内容量撑不起一页，还会摊薄有限的站内权重；一个 `#faq` 足够。
- **`alternateName` 写 "super agent"**：该字段语义是「本产品的另一个名字」，写成官方名属于事实错误。
- **npm keywords 加 `superagent`**：会把自己排到那个研究原型旁边，装错包的人算在自己头上。

## Consequences

- 能拿到的是「super agent 对比 / 替代 / 区别」这类长尾，head 词拿不到；品牌词能否换掉 GitHub 深层页取决于收录与外链，不由页面改动决定。
- FAQ 的对比文案要随原型演进重写，官方改定位后这段会过时。
- `FAQPage` 富结果 Google 现在基本只给权威站点展示，这里的作用是语义与收录，不要按 SERP 上会出现折叠问答来预期。
- README 预算随之上调（README.md 3555、README_ZH.md 5310，余量 5.2% / 5.1%）。
- 收益：落地页第一次同时覆盖品牌写法与相邻概念，而且对「是不是官方」给出了明确回答。

## Testing

本地 chromium（1440 / 390）：0 console error / 0 pageerror、无横向溢出；两段 JSON-LD 都能解析且 FAQPage 答案与可见文本一致（覆盖 h2 问 + 前两条 `.faq-item`，第三条只在可见层）；`alternateName` 为 `dsh leader agent`；点导航 `#faq` 后 `document.activeElement` 是 `#faq`，kicker 与 h2 都不被吸顶 header 遮挡；title 73 字符，首屏仍能看到 `dsh leader agent`。`npm run check` 全绿。
