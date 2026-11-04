# 卡片详情支持编辑链接


**范围**：`src/shared/card-links.js`、`src/shared/projects.js`、`src/host/projects/remote.js`、`src/host/tools/cards.js`、`src/client/project-remote.js`、`src/client/card-links-editor.js`、`src/client/card-detail.js`、`src/client/card-detail-view.js`、`src/client/board.js`、`src/client/board-projection.js`、`src/client/board-styles.js`、`src/client/link-row.js`、`tests/card-links.test.js`、`tests/cards-tools.test.js`、`tests/project-remote*.test.js`、`tests/board-projection.test.js`、`tests/card-detail-view.test.js`、`README.md`、`docs/`

## 背景

看板点开卡片详情只能看：说明与链接两段都是只读。链接本来归协调者的 `update_card`，可漏挂、写错、事后补链接都是常态——那时用户只能回会话里让模型改卡，而看板正是他看见问题的位置。同类工具的任务卡片详情里链接是可直接编辑的（「编辑链接」→ 行内输入 → 保存），本仓的呈现面朝它对齐。

## 决策

### 写通道只开一条：`updateCardLinks(id, links)`

挂在既有的 `projects` Typert 命名空间上，宿主侧转调 `cards.update({ id, links })`，整体替换。不给「加一条 / 删一条」的细粒度方法：列表量级只有几条，整体替换让并发语义简单（后写者赢），也避免界面与服务各维护一套序号。

**不传 `expectedRevision`**：详情浮层里的卡片是打开瞬间的快照，用户编辑期间协调者改过卡时，用快照版本号会稳定触发冲突；而用户在这里表达的意图就是「这些链接现在是这样」。代价是覆盖同一时刻协调者的 `links` 变更，这一取舍写在 `docs/architecture.md`。

### 契约形状：参数名 → 线上类型

`PROJECT_REMOTE_METHODS` 从 `{ method: ['id'] }` 改为 `{ method: { id: 'string', links: 'links' } }`。浏览器侧据此给每个参数选严格 codec（`string` / 数组），宿主侧只读方法名，形参名仍逐字对齐契约。新增类型必须在这里登记，`codecFor` 对未知类型直接抛错——不会静默退化成字符串 codec 而在调用时才失败。

### URL 判定与归一化收在共享模块，三条写入路径都守

`src/shared/card-links.js` 导出两个函数，判定与落盘同源：

- `normalizeHttpUrl(value)`：`new URL(value.trim())` 能解析且 protocol 是 `http:` / `https:` 时返回规范形式 `href`，否则返回 `null`；
- `isHttpUrl(value)` 就是 `normalizeHttpUrl(value) !== null`，渲染层与写入层不会对同一个值给出两种口径。

三条写入路径都用这一份：**浏览器侧编辑态**（`normalizeLinkDrafts` 的保存前校验，即时反馈）、**宿主侧写通道**（`updateCardLinks`，客户端校验不能当边界，落盘前再跑一遍）、**卡片工具**（`create_card` / `update_card` 的 `normalizeLinks`，模型是另一个写入者）。`normalizeLinkDrafts` 与 `normalizeLinks` 都把 `url` 换成 `normalizeHttpUrl` 的返回值后再落盘。

**为什么选归一化而不是拒绝**：`http:example.com`、`https:/example.com`、内嵌换行的地址在 WHATWG URL 里本来就是合法的 http(s) 绝对地址，浏览器导航也按同一规则解释；拒绝会把能用的地址判死，而归一化能让落盘值与界面 `href`、文档口径一致。探针读数（Node 24）：`http:example.com` → `http://example.com/`，`https:/example.com` → `https://example.com/`，`https://exa\nmple.com` → `https://example.com/`；三者都不再原样落盘。相对的，`javascript:`、`ftp:`、`//evil.example`、相对路径仍被拒。

工具侧的报错是写给模型看的，所以每条都带「第几条、哪个标签、收到的原值、该怎么改」——只说「url 非法」会让它原地重试。错误文案与相关文档（`docs/usage.md`、`COORDINATOR.md`、工具 schema 描述）都改成「能归一化为 http(s) 绝对地址」，不再把「以 `http://` 开头」当硬条件（归一化会接受省略 `//` 的写法）。

### 工具侧的错误信息必须可执行

`normalizeLinks` 的报错改成结构化句式：`卡片工具: links 第 2 条（label「Issue」）的 url 必须是 http(s) 绝对地址，收到 "docs/report.md"；请改成 https://… 这样的完整地址，或者去掉 url 字段`。非字符串字段也带类型与收到的值（`describeValue`）。同一处还统一了 trim、空 url / purpose 删字段、重复 id 换新 id——与看板编辑态的规范化口径一致，避免「模型写入的卡在界面上编辑一次就变样」。

### 交互：编辑入口在「链接」段标题行，编辑态整段替换

「编辑链接」只在非归档卡上出现，点开后列表换成编辑器：每行一条链接（标签窄、URL 占宽、行尾移除），用途默认收起、点「添加用途」展开，底部「+ 添加链接」与「取消 / 保存」。整行都空的新增行在保存时丢弃；只填了 URL / 用途却漏标签的报错——粘贴 URL 后回车就保存，静默丢行比拦住他更糟。

保存成功后宿主返回的卡片同时回填浮层快照与卡面列表（`board.js` 的 `cardUpdated`），用户不必关掉重开或等下一轮轮询。两处合并都按 id / revision 判定（`mergeCardUpdate` / `mergeCardSnapshot`）：在途的轮询响应晚到时不会把刚保存的链接打回旧值，保存期间关掉浮层再打开另一张卡也不会被错卡的结果覆盖。详情浮层这一处判定抽成纯函数 `mergeDetailCard`，单测直接锁「A 的保存结果不落到 B」。

**编辑态的焦点**：进入编辑态把焦点放到首个 label（没有链接时落到「+ 添加链接」），取消或保存后回到「编辑链接」按钮，避免按钮被替换后焦点落到 body、下一次 Tab 被浮层焦点陷阱收边到「关闭」。保存期间控件 `disabled` 会让焦点 blur，所以失败时在 `finally` 之后把焦点还给提交前的元素（Enter 提交回到输入框，点「保存」则回到重新启用的按钮），成功与取消仍由外层回焦「编辑链接」。聚焦规则复用 `modal-focus` 的 `pickInitialFocus`（首个 `[data-modal-autofocus]` → 首个可聚焦元素）。这一条只有代码与构建证据，未做 GUI 点击实测。

### 渲染层也认 http(s)

`isJumpableLink` 由「有 url 就跳」改成「http(s) 才跳」，其余渲染成文字（点它开详情）。三条写入路径现在都拦非法 scheme，但**存量卡**是校验上线之前写进去的——那里的 `javascript:` 一旦拼进 `<a href>` 就是注入面，渲染层必须自己守住。相对路径与本地文件链接因此不再可点，这与卡片链接的约定（PR / Issue）一致。相关注释同步改成「写入边界只认 http(s)、渲染层兜存量卡」，不再说工具接受任意字符串 url。

## 边界

- **只有 links 可写**：完成、置顶、重命名、删除、改槽位仍归协调者的卡片工具，卡面也不放操作按钮。
- **存量非 http(s) 链接**：校验上线前写入的卡仍带着相对路径或非 http(s) 地址，渲染层已把它们降级成不可点击的文字；这类卡打开详情保存时会被拦，需要用户改成 http(s) 或删掉那一行的 url。
- **URL 规则是 http(s) 绝对地址**：`mailto:`、`file:`、内网裸域名（`example.test/mr/1`）会被拒。非规范写法（`http:example.com`、`https:/example.com`、内嵌换行）会被归一化成规范形式再落盘，**不保留用户输入的原貌**——编辑态重开看到的是规范化后的地址。卡片链接的约定是 PR / Issue 这类网页地址；要放宽就得同时决定「渲染层哪些 scheme 安全」，不该只改写入侧。
- **跨项目判定不在写通道上**：远程方法是 `direct` 调用，拿不到调用方会话，无法像 `update_card` 那样比对卡片归属。这条通道经官方 `/api` 同源链路到达宿主，任何能调 `/api` 的本机页面或进程都能按 id 改任意项目的卡——这是单机单用户威胁模型下的取舍，方法注释里已明示；要挡误用可以加 `projectId` 参数做一致性检查，但它不提升安全性。浏览器侧按构造只能看到本项目的卡片，通道是「用户自己的机器上、用户自己的卡片」这一层权限，不比工具更宽。
- **详情仍是打开时快照**：协调者在别处改卡不会刷新浮层，只有本浮层自己保存的链接会立刻回填。
- **清空是显式意图**：编辑态把所有行删光再保存就是清空链接，不做「至少留一条」的保护。
- **归档卡是终态**：不给入口，卡片库本身也会拒改；浮层快照还没刷新时保存归档卡，会看到宿主带回的「已归档」原因（`callProjectRemote` 现在把 `error.message` 一起抛出来）。

## 验证

- **rebase 到 main**：原分支基于 `f531c62`，`git rebase origin/main` 到 `5b40f79`。冲突只有 `README.md:13` 与 `docs/usage.md`：README 取并集（「带槽位信号灯与详情浮层（链接可直接编辑）」+ main 新增的「卡片说明与 worker 回报正文按 Markdown 渲染」整句）；usage 保留本分支新增的 `links` 规则段，再接 main 改写后的「卡片落盘…（含 Markdown 渲染）」段，没有回退成 base 旧段。其余文件自动合并。rebase 后基线为 705 例（main 的 #52 / #58 / #62 已进入），本轮的 5 例是加在基线之上的。
- **单测**：`npm run check` → `tests 710 / pass 710 / fail 0`。新增 5 例：`tests/card-links.test.js` 2 例（`normalizeHttpUrl` 与 `isHttpUrl` 同源、写入边界三种非规范形态归一化）、`tests/cards-tools.test.js` 1 例（工具写入边界归一化）、`tests/projects-remote.test.js` 1 例（写通道归一化）、`tests/board-projection.test.js` 1 例（保存期间切到另一张卡，旧卡结果不落到新卡）。
- **双向验证（S2）**：把 `normalizeHttpUrl` 改成返回 `value.trim()`（即不归一化，只校验）→ 上述 4 条归一化用例变红（card-links 2、cards-tools 1、projects-remote 1）→ 还原后全绿。
- **双向验证（S4）**：把 `mergeDetailCard` 的 id 判定去掉、改成无条件替换 → 「保存期间切到另一张卡，旧卡结果不落到新卡」变红 → 还原后全绿。
- **前一轮的双向验证仍保留**：把宿主侧 `normalizeLinkDrafts` 校验临时换成 `{ links }` 直通 → 改链接的两例变红；把 `isJumpableLink` 退回「有 url 就跳」→ scheme 用例变红；把工具侧 URL 校验改成 `false` → URL 用例变红；均已还原。
- **模型看到的报错**（真实 `create_card.execute` 读数）：

  ```
  卡片工具: links 第 2 条（label「设计稿」）的 url 必须是 http(s) 绝对地址，收到 "docs/design.md"；请改成 https://… 这样的完整地址，或者去掉 url 字段
  卡片工具: links 第 1 条缺 label（这一条带了 url "https://github.com/o/r/pull/1"，但链接必须有非空 label）；每条链接都要有非空 label
  卡片工具: links 第 1 条（label「MR」）的 url 必须是字符串，收到 number 42
  ```
- **真实落盘**：临时 HOME 里用真实 `createCardStore` + `createProjectRemote` 跑一次，`links` 落盘为 `[{id:'l1',label:'新 PR',url:'https://example.com/new',purpose:'交付'},{label:'Issue',id:'<uuid>'}]`，revision 0 → 1；`javascript:alert(1)` 与 `ftp://…` 均被拒。本轮另在单测里验证 `http:example.com` / `https:/example.com` / 内嵌换行三种形态按规范形式落盘。
- **构建**：`npm run build:client` 退出 0，`lib/client.js` 217289 B。产物外部 `require` 只有 `react`（14 处）、`react-dom`（3 处）与基线包 `@deepseek-ai/dsh-client-ui-primitives`（1 处，来自 #52 的 Markdown 渲染）；无 `node:` 内置模块。
- **审查后的修复**（PR #53 复审）：B1 按并集口径 rebase 解冲突；S1 注释改成「三条写入路径只认 http(s)、渲染层兜存量卡」；S2 写入边界归一化并补 4 条边界用例；S3 在 `updateCardLinks` 方法注释明示不做项目归属校验、原因与 `/api` 信任面，architecture 同步；S4 抽出 `mergeDetailCard` 并补错卡用例；S5 补编辑态进入/退出焦点。第二轮复审：S2 把 `COORDINATOR.md`、`cards.js` 的 schema 描述与 JSDoc、本 Note 里残留的「`http://` 开头」改成「能归一化为 http(s) 绝对地址」；S5 补保存失败后的焦点恢复（`finally` 之后把焦点还给提交前元素）。
- **未做 GUI 实测**：隔离实例（`.dev/home`，`DEV_PORT=5391`）能起、页面 console 只有 Electron CSP 警告，但 Browser 会话在后台、视口为 0×0，所有点击都返回 `BROWSER_ELEMENT_OUT_OF_VIEW`，没能点到卡面与保存按钮。浮层渲染、增删行、保存回填、错误展示、IME 回车与 S5 的焦点行为都只有单测/构建/代码阅读证据，留待有可见浏览器面板时补一次取证。
