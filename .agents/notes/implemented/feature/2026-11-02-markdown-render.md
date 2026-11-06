# 卡片说明与 worker 回报改用宿主 Markdown 渲染

## 背景

卡片详情浮层的「说明」段与 worker 回报气泡的正文都是人手写的 Markdown：标题、列表、行内代码、代码块、表格在 worker 的产物摘要里随处可见。两处此前都按纯文本渲染（`white-space: pre-wrap`），语法字符原样显示，读的人得自己解析结构。

落地前先核对宿主有没有现成能力。宿主 web 端的聊天消息本身就是 Markdown，渲染器是 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`；而 `ui-primitives` 自 `dsh-v0.2.1-rc.2`（`engines.dsh` 下限）起就在 `PLATFORM_MODULES` 基线里，`seed.ts` 把它静态 import 进冻结模块表，注释写明「every bundle sees the same instance」。基线里的宿主自有包不止它一个（rc.2 还有 `client-store` / `ui-slots` / `ui-dockkit`），本仓只用到 `ui-primitives`。

## 决策

### 复用基线模块的 `MarkdownText`，不自写解析器

第一版实现是自写的轻量解析器（块级 + 行内 + 样式，约 900 行）。确认基线模块可 require 后整份删除，不保留双路径：自写版要复刻 GFM、代码高亮、URL 白名单与流式解析，排版也必然与聊天消息不一致；复用后两处气泡与官方消息同源。

`src/client/markdown.js` 只剩一层薄封装：原文为空返回 `null`（避免渲染空容器），其余交给 `createElement(MarkdownText, …)`。宿主自带 URL 协议白名单（`http` / `https` / `mailto`）与 HTML 转义，不需要再写一层安全过滤。

### 构建期把 `ui-primitives` 留在产物外

它与 `react` 同属基线模块，运行时由宿主冻结模块表提供同一实例。基线（rc.2 的 `PLATFORM_MODULES`）里有四个宿主自有包：`client-store` / `ui-slots` / `ui-primitives` / `ui-dockkit`，本仓只用到 `ui-primitives`。

出处是宿主侧的两处真源：`packages/client/web/src/platform.ts:8` 的 `PLATFORM_MODULES`（`ui-primitives` 条目在 `:13`；文件头 `:1-5` 写明 seeding / bundling / Vite aliases 共用这张表），与 `packages/client/web/src/seed.ts:9-19` 的静态 import（`ui-primitives` 在 `:18`）、`:26` 的 `getStaticModules`（文件头 `:1-8` 写明这是 shell 共享进冻结模块表的**唯一**集合）；`docs/subsystems/web-client.zh.md:93` 把 `ui-primitives` 列为「共享运行时值的静态 owner」之一。这些 `src/` 文件不在 npm 安装包里（`files` 只发 `lib/`），核对对象是**源码仓的 `dsh-v0.2.1-rc.2` tag**（`git show`），不是安装产物。

`build/client.mjs` 的 `BASELINE_EXTERNALS` 加上它；manifest 的 `dsh.client.external` 仍为空——基线模块本来就能解析，重复声明反而违规（`scripts/verify-client-packages.ts:347` 的 `dsh.client.external repeats baseline module`）。

这张表不是承诺：宿主可以随版本增删条目。真正的漂移风险在这里——`ui-primitives` 一旦被移出基线，产物里的外部 `require` 解析失败，插件的客户端半边整个起不来（模块求值阶段就抛）。核法同样是按 `engines.dsh` 下限的 tag 对照 `platform.ts`，而不是看本机最新版。

### 固定 `variant="compact"`

两处调用点都是窄容器：`body` 变体是文档排版（`h1` 32px 上下 margin），会把气泡撑成文档页；`compact` 是 13px 字号、统一粗细的标题、4px 块间距，与聊天消息里的短内容一致。

### `labels` 用模块级常量

`MarkdownText` 按 `labels` 的身份判断是否重建流式渲染缓存，每帧新建对象会让缓存失效。文案固定中文（组件要求必填，本仓不做多语言）。

### 气泡折叠改成 `max-height`

正文从纯文本变成块级元素（`p` / `ul` / `pre`）后，`-webkit-line-clamp` 只能截纯文本行，对块级子元素不生效。折叠态改为按行高算 `max-height`（`2 × (20px + --dsh-content-font-delta-secondary) + 4px`，多出的 4px 是 compact 段落的上边距），超出部分 `overflow: hidden`。裁剪挂在正文层 `__content` 上、不挂在气泡上：展开开关是气泡内的第二个子元素，气泡自己裁剪会把按钮一起裁掉。溢出测量仍是 `scrollHeight > clientHeight`，语义不变；展开态不量，按钮可以点回折叠。

展开开关与正文之间留 6px（2px 时它看着像最后一块内容的一部分），气泡底部留 12px。

两处 `white-space: pre-wrap` 一并删掉：换行改由 Markdown 的块级结构与 `br` 决定，留着会和 Markdown 的缩进、换行叠成双份。旧消息的回退路径例外，见下一节。

### compact 变体的颜色在本仓覆盖

宿主 `MarkdownText` 的 CSS 里，`.markdown` 设 `color: --dsw-alias-label-primary`、`.compact` 设 `--dsw-alias-label-tertiary`，两者挂在同一个根节点上、特异性同为 (0,1,0)，`.compact` 靠源顺序胜出；链接同理，`.compact a` 的 `color: inherit` 压过 `.markdown a` 的 `--dsw-alias-link`。两处容器原本都是 primary 正文，直接复用 compact 会把正文改暗、链接失去链接色。本仓在 `.dsh-leader-agent-card-detail-text` 与 `.dsh-leader-agent-agent-bubble__bubble`（2026-11-06 起由 `dsh-leader-agent-worker-report__bubble` 改名，见 [2026-11-06-leader-task-bubble.md](2026-11-06-leader-task-bubble.md)）内用宿主暴露的 `data-markdown-variant="compact"` 钩子压回 primary / link 色：容器类 + 属性选择器是 (0,2,0)，高于 `.compact` 的 (0,1,0)；链接再叠标签选择器到 (0,2,1)，高于 `.compact a` 的 (0,1,1)。特异性严格更高，不依赖哈希类名，也不依赖样式表注入顺序。

### 气泡材质跟宿主消息气泡

底色用宿主给气泡的专属令牌 `--dsw-specific-bubble`（light 是 `deepseek-50`、dark 是 `neutral-bluish-850`，rc.2 就有），不自己按 `label-primary` 混百分比——后者在深浅主题下强度不一致、看上去偏灰。宿主的用户消息气泡也没有描边，这里一并去掉 1px 边框；圆角与内边距沿用宿主口径（`--dsw-radius-xl`、`10px 16px`），底部多留 2px 给展开开关。

### 旧消息回退与失败原因保持纯文本

`workerReportFormat` 按三件事选渲染方式：终态失败、`report` 是否存在、`report` 有没有块级结构。

- **失败原因**（`失败：<reason>`）是原样透出的错误文本、可能多行，走纯文本。
- **没有 `report` 的旧消息**回退的是整条通知正文，逐行的协议字段（子会话、状态、下一步），走纯文本 `pre-wrap`。
- **有 `report` 的多行正文**只有出现块级标记（标题、列表、围栏、表格、引用）才走 Markdown；没有块级标记的多行走纯文本。原因是 `report` 自 #8 起就随通知落盘，那时的多块用**单个 `\n`** 连接（`blocksToText` 的默认分隔符），本 PR 才改成 `\n\n`——这类记录是一串纯文本块，交给 Markdown 会被软换行折成一段。块级标记本身会分段，不受影响；单行正文不存在折段，照常渲染行内语法。行内语法（`**粗**`、`` `code` ``）不参与判定，判据只是行首的块级语法。

契约的另一半在生产者侧：`blocksToText` 加可选分隔符参数（默认仍是 `\n`，通知正文 `buildNotificationText` 用它）；`buildWorkerReport` 生成的 `report` 随通知落盘，多块用 `\n\n` 连接，让交给 Markdown 的段落之间有空行。

## 边界

- **基线模块可直接复用；风险方向是宿主把条目移出基线**。基线模块是宿主公开的共享契约（`packages/client/web/src/platform.ts:8` 的 `PLATFORM_MODULES`、`seed.ts:9-19` 的静态 import 与 `:26` 的 `getStaticModules`、`docs/subsystems/web-client.zh.md:93` 把 `ui-primitives` 列为共享运行时值的静态 owner），因此本仓不写 `dsh.client.external`。这张表没有跨版本承诺：宿主删掉条目，产物里的外部 `require` 就解析失败，插件客户端半边在模块求值阶段整个起不来——`engines.dsh` 下限升级时按 tag 复核 `platform.ts` 的条目，而不是看本机最新版。「基线外」也不等于宿主禁止引用：`dsh.client.external` 可以引入由另一个插件行（dynamic row）supplier 的模块，校验还会要求生产源码里确有对应 import（`scripts/verify-client-packages.ts:352-381`），只是这些包不承诺运行时可解析。`Modal` / `Menu` 是基线包 `ui-primitives` 的导出、本来就在基线内；本仓仍照源码复制改写，动机是定制（类名前缀、按本仓交互调整行为），不是它们不可用。代价是宿主改 `MarkdownText` 的签名或 `compact` 排版时本仓要同步（`MarkdownText` 的签名与 `variant` 取值在 `dsh-v0.2.1-rc.2` tag 已核过）。
- **远端图片会渲染**。宿主渲染器对 http(s) 图片按默认行为出 `<img>`，与聊天消息一致；`pathImages` 不传，本地路径图片不出图。若将来要禁止外部资源加载，得在传入前处理图片语法，渲染器本身在 rc.2 没有开关。
- **代码块工具栏随组件一起出现**。复制、换行按钮会出现在气泡与详情里的代码块上，这是宿主组件的固定 chrome，不是本仓加的。
- **排版随宿主主题**。字号、行高、间距来自 `--dsh-*` 令牌与 `compact` 样式，宿主题变化时本仓不改样式也变。
- **旧消息回退与失败原因保持纯文本**。协议字段按行排列，不该走 Markdown 的软换行；失败原因来自 `error.message`，同样可能多行。新消息的多块摘要由 `buildWorkerReport` 用 `\n\n` 连接并随通知落盘；通知正文（`buildNotificationText`）仍用 `blocksToText` 的默认 `\n`。
- **颜色覆盖依赖宿主的属性钩子与 token**。`data-markdown-variant` 是宿主 `MarkdownText` 暴露的 DOM 属性（只在 compact 变体上出现），`--dsw-alias-label-primary` / `--dsw-alias-link` 是宿主主题 token；宿主改属性名或 token 名时覆盖会静默失效（正文又变暗），要同步。

## 验证

- 单测 657 例全绿；`tests/markdown.test.js` 新增 8 例：走基线模块、固定 compact、构建期 external 清单、两处调用点接线、折叠实现不再是 line-clamp（含「气泡本身不裁剪」）、展开开关在气泡内、气泡底色用 `--dsw-specific-bubble`、compact 颜色覆盖；`tests/worker-report.test.js` 新增 4 例（`workerReportFormat`：旧消息回退纯文本、单换行连接的旧回报走纯文本（含块级标记反例）、空行分隔的新回报走 Markdown、失败原因纯文本）；`tests/dispatch.test.js` 新增 1 例（多块产物摘要用 `\n\n` 连接，通知正文仍用单换行）。
- 下限核对读数：`git show dsh-v0.2.1-rc.2:packages/client/web/src/platform.ts` 与 `seed.ts` 在 tag 上与仓库 HEAD 内容一致——`ui-primitives` 在 `platform.ts:13` 的 `PLATFORM_MODULES` 条目里、`seed.ts:18` 静态 import 进 `:26` 的 `getStaticModules`，容器在两者都有 `satisfies` 对齐。安装产物里查不到这些文件（`files` 只发 `lib/`），所以核对对象只能是源码仓同 tag。
- 双向验证（原接线）：把 `worker-report-view.js` 的 `createElement(Markdown, { source: body })` 改回裸 `body`（2026-11-06 起这段接线移到 `agent-bubble-view.js`），「两处调用点都渲染 Markdown 组件」变红；还原后全绿。
- 双向验证（颜色覆盖）：删掉两个样式文件里的 `[data-markdown-variant='compact']` 覆盖规则 → 「两处容器用 data-markdown-variant 钩子恢复正文与链接色」变红（报 `src/client/board-styles.js 没有把正文色恢复成 primary`）；还原后全绿。
- 双向验证（旧消息回退）：把 `workerReportFormat` 改成恒返回 `'markdown'` → 「旧消息回退的整条正文走纯文本」变红；把 view 改回无条件渲染 `Markdown` → 「两处调用点都渲染 Markdown 组件，旧消息回退纯文本」变红；各自还原后全绿。
- 双向验证（多块摘要）：把 `buildWorkerReport` 的 `blocksToText(..., '\n\n')` 改回默认单换行 → 「多块产物摘要按空行连接」变红；还原后全绿。
- 双向验证（失败原因）：删掉 `workerReportFormat` 的 `outcome === 'failed'` 分支 → 「失败原因的回报保持纯文本」变红；还原后全绿。
- 双向验证（旧回报保守判定）：把 `workerReportFormat` 改回「有 `report` 就 `markdown`」（去掉 `BLOCK_MARKERS` 判定）→ 「单换行连接的旧回报走纯文本，有块级标记或空行才判 Markdown」变红（`'第一块\n第二块'` 判成 `markdown`）；还原后全绿。判定边界的对抗读数：`第一块\n第二块` → `text`、`## 摘要\n\n- 改完了` → `markdown`、单行的「改完了 + 行内代码」→ `markdown`、`第一块\n-不是列表`（列表符后无空格）→ `text`、4 空格缩进代码块 → `text`（不识别，保守走纯文本）。
- 双向验证（空行信号）：删掉 `report.includes('\n\n')` 判定 → 「空行分隔的新回报走 Markdown」变红（`'第一段 a.js\n\n第二段 b.js'` 判成 `text`，行内代码按字面显示）；还原后全绿。这条是新记录（多块 `\n\n` 拼接）的正向覆盖，与上一条的保守方向互补。
- 构建读数：`npm run build:client` 后产物里的外部 `require` 只有 `react`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives` 三处，宿主包未被打进产物（颜色覆盖与回退改动不新增依赖）。
- computed color 探针（无头 Chrome + 宿主安装产物 `index-BxpfOGf3.css` + 宿主主题 light token，宿主 CSS 原文不动）：覆盖前正文与链接的 computed color 都是 `rgb(129, 133, 140)`（`--dsw-alias-label-tertiary`）；加上两个容器的覆盖规则后正文 `rgb(15, 17, 21)`（`--dsw-alias-label-primary`）、链接 `rgb(65, 118, 230)`（`--dsw-alias-link`）。把覆盖样式放在宿主 CSS 之前也得到同一读数，说明压过 `.compact` 靠的是特异性而不是注入顺序。
- 真机（dsh `0.2.1-rc.2`，隔离 `DSH_HOME` 的 dev 实例，无头 Chrome 走 CDP 驱动页面）：页面加载、项目入口出现；点项目行 → 开右栏 → 看板 Tab 与 seed 的卡片 `#1` 渲染。console 无模块解析错误（只有 Electron 既有的 CSP 警告），说明 client bundle 在模块求值阶段成功 require 了基线里的 `ui-primitives`——静态 import 失败会让插件 apply 整个起不来。
- 真机读数 · 卡片详情：`.dsh-leader-agent-card-detail-text` 的第一个子元素 class 是 `_markdown_1ypvv_5 _compact_1ypvv_331`（宿主 `MarkdownText` 的 CSS module 类 + `compact` 变体）；内部 `h1` 1、`h2` 2、`ul` 2、`li` 3、`strong` 1、`code` 2、`pre` 1、`table` 1、`blockquote` 1、`a` 1；段落 computed `font-size: 13px`、`line-height: 20px`；链接 `href="https://example.com"`。
- 真机读数 · worker 气泡（mock provider 驱动一次真实 `spawn_worker`，worker 回报为含标题、列表、行内代码、引用的 Markdown）：折叠态 `data-collapsed="true"`、正文层 `clientHeight 44` / `scrollHeight 138`、气泡整体高 90、`background-color: rgb(237, 243, 254)`（`--dsw-specific-bubble` = `deepseek-50`）、`border-width: 0px`、`padding: 10px 16px 12px`；按钮文案「展示更多」，其 `bottom` 在气泡内、与正文间距 6px、距气泡底 12px。点开后 `data-collapsed` 清空、正文层 `clientHeight` 涨到 138、气泡高 184，按钮变「收起」且仍在气泡内。气泡内部是 `_compact_` 变体，`h2` 1、`ul` 1、`li` 3、`strong` 1、`code` 2、`blockquote` 1。折叠/展开两态截图看过：按钮不再跟着两行水位被裁，底色与宿主消息气泡一致。
- 本轮（气泡视觉调整）复跑了 GUI：底色、边框、padding、折叠水位与按钮位置都是无头 Chrome 读的 computed 值与 `getBoundingClientRect`，不是从 CSS 声明推断；折叠态与展开态各截一张图核对（截图不入库）。
- 取证方式：本仓没有入库的 e2e 基建，这轮用 `/tmp` 的临时探针（无头 Chrome + CDP、mock LLM server），验证完已删。宿主的 `vitest.e2e` / `apps/web/tests` 依赖宿主仓路径别名与 Host 服务 fixture，外部仓跑不了；可复用只到浏览器驱动层。
