# Agent Note: 客户端界面文案收口到 locale 字典

Status: implemented

## Problem

本插件的 locale 字典原本只覆盖内置槽位名、引导卡与会话标签栏的少量文案；其余界面字符串直接写死在组件里。后果在英文界面里最明显：右栏 tab 标题、guide 入口说明、左栏「项目」标题、看板空态与错误页、卡片详情、链接编辑器、项目菜单、气泡时间与复制按钮都显示中文。tab 标题尤其显眼——它是右栏唯一的常驻标签，用户第一眼就会看到「看板」出现在英文宿主里。

一半走字典、一半硬编码还会让「漏翻」不可发现：加一个键或改一句文案，没有任何机制提示另一条路径。

## Decision

- **字典仍只有一份**：`src/client/locales.js` 的 `zh` / `en`，命名空间 `dsh-leader-agent`。键按界面区域分组（`tab.*` / `project.*` / `board.*` / `card.*` / `bubble.*` / `markdown.*`），通用按钮（取消、关闭、删除、收起、保存）收进 `common.*`。
- **组件统一用宿主注入的 `t`**：凡是能声明 `locale: SLOT_LOCALE_NAMESPACE` 的 slot 注册都声明；`ProjectPanel`、会话节点气泡、看板面板与卡片详情由此拿到当前语言的 `t`，切换语言时重新渲染。
- **注册期文案用 `ctx.locale.bind`**：tab 类型定义、guide 条目的 `title` / `description`、左栏 footer 的 `label` 都是 thunk，宿主每次投影重读；`bind` 返回的函数在调用时读当前语言，切语言后不必重新注册。
- **tab chip 单独接一个标题席位**：宿主在打开 tab 时把 `title` thunk 的结果写进布局记录，只靠 thunk 的话切语言仍停在打开时的快照。插件在 `sidebar.right.pane.tab.title` 按 definition id 注册自己的标题组件，让常驻标签跟着语言走。
- **纯函数改为收 `t`**：`validateProjectName`、`planProjectRename`、`defaultProjectName`、`openLeaderSession`、`buildProjectMenuItems`、`describeProjectRemoval`、`describeDeletionNotice`、`statusLabel`、`describeCardRemoval`、`foldRows` / `foldSessions` / `foldDoneCards`、`formatBubbleClock` 不再产出中文常量。测试从真实字典取译文（`tests/helpers/locale.js`），不另抄一份期望文本。
- **带复数的折叠文案进字典**：`session.fold.expand` / `board.fold.expand` 用 `{count}` 占位符，中文「N 个会话」「N 张卡」、英文「N more sessions」「N more cards」。
- **时间与 Markdown 工具栏也走字典**：气泡日期模板（`bubble.clock.*`）按语言给；宿主 `MarkdownText` 的复制 / 代码块工具栏标签由 `markdown.*` 提供，按文案内容缓存 labels 对象，保持宿主流式渲染要求的引用稳定。
- **`zh` 是键集事实来源**：`tests/locales.test.js` 门禁中英键集一致、占位符一致、没有空文案。

## Alternatives considered

- **把界面文案塞进 `locale/*.json`**：那里是宿主的包元信息（市场卡片标题/描述），`package-meta.ts` 只读 `title` / `description`，运行时不读界面字符串。
- **组件里保留中文兜底**：`typeof t === 'function' ? t(key) : '中文'` 会让英文界面在 t 缺失时静默露出中文；声明 `locale` 后 `t` 是契约的一部分，缺了就该炸。
- **每个组件自带一份字典**：键名与译文各写一份，改一处漏一处；单文件字典加键集门禁能机械发现漏翻。
- **监听 `locale/change` 重新注册 tab**：宿主没有给 tab 类型重新注册的扩展点，重注册还会把已打开的布局打乱；thunk + title 席位即可。
- **把宿主工具描述与远程错误也翻译**：工具描述是模型可见，不是界面文案；远程错误的真源在宿主，客户端只能包前缀。
- **共享链接校验单独翻译**：`src/shared/card-links.js` 的校验结果同时供宿主写通道与浏览器编辑态使用，宿主侧没有语言上下文；本轮不拆错误码。

## Consequences

- 新增或改动任何用户可见文案，必须同时补 `zh` 与 `en`，否则 `tests/locales.test.js` 红。
- **残留的中文**：`src/shared/card-links.js` 的链接校验错误（编辑态会显示）、`src/client/project-remote.js` 的通道诊断、日志与内部异常仍是中文；它们要么跨宿主/浏览器共用，要么只服务开发者。共享校验若要翻译，需要把错误从字符串改成 `{ key, params }` 并同步宿主写通道。
- tab chip 多一个按 `PLUGIN_ID` 注册的标题席位；宿主没有该席位时仍回落到打开时的快照。
- 看板已完成区的中文折叠文案从「展开其余 N 个卡片」改为「展开其余 N 张卡」，英文语法也随之修正。
- `bubble-clock.js` 不再固定中文形态；模块头注释同步删掉「本仓不做多语言」。

收益：英文界面里插件自己的所有常驻文案（右栏 tab、左栏区块、看板、详情、气泡）都跟随界面语言，漏翻由字典门禁兜住。

## Testing

`tests/locales.test.js`（键集/占位符/空文案）与 `tests/helpers/locale.js`；受影响的纯函数用例改为从真实字典取译文。新增 `tests/e2e/i18n-english.e2e.js`：`locale: 'en-US'` 起真实宿主，断言左栏标题 `Projects`、guide 入口 `Board`、看板 tab chip `Board`、空看板 `No cards yet`，并断言这些区域不含 CJK。

双向验证：把 tab 标题改回 `'看板'` → 英文 e2e 在「看板 tab 标题是英文 Board」处超时变红；还原后全绿。中文侧回归重跑 `plugin.e2e.js`、`board-card-delete.e2e.js`、`board-done-paging.e2e.js`。
