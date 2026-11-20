# Agent Note: 客户端界面文案收口到 locale 字典

Status: implemented

## Problem

本插件的 locale 字典原本只覆盖内置槽位名、引导卡与会话标签栏的少量文案；其余界面字符串直接写死在组件里。后果在英文界面里最明显：右栏 tab 标题、guide 入口说明、左栏「项目」标题、看板空态与错误页、卡片详情、链接编辑器、项目菜单、气泡时间与复制按钮都显示中文。tab 标题尤其显眼——它是右栏唯一的常驻标签，用户第一眼就会看到「看板」出现在英文宿主里。

一半走字典、一半硬编码还会让「漏翻」不可发现：加一个键或改一句文案，没有任何机制提示另一条路径。审查还发现两处「不是界面文案」的错误结论：`project-remote.js` 的通道诊断会进左栏与 toast；`card-links.js` 的校验错误由链接编辑器直接显示。

## Decision

- **单一来源**：`locale/<code>.json` 同时放 `meta` 与 `ui`。`meta` 只有 `title` / `description`，宿主 `package-meta.ts` 读 `locale/en.json` 后扫同目录全部 JSON、用文件名小写作为语言 id，只取 `meta`；`ui` 由本插件消费。界面字典不再写在 `src/client/locales.js`。
- **构建期生成、生成物入库**：`build/locales.mjs` 扫 `locale/*.json` 生成 `src/client/locales.generated.js`；`index.js` 用 `LOCALE_UI` 枚举注册，不出现具体语言名。选择入库 + `--check` 而不是打包时生成：生成物随 `src/**` 发布，安装后不依赖额外构建步骤，字典变化也能在 diff 里审查；`npm run check` 的 `--check` 会拦住过期文件。
- **与宿主语言对齐**：客户端注册键直接用宿主 locale id（`zh` / `en`），不是浏览器标签 `zh-CN` / `en-US`。生成器只接受小写 BCP 47 风格文件名；`en` 必须存在，因为宿主缺 key 时回退英文。
- **宿主契约实测结论**：宿主内建 `zh` / `en`，另注册 `ja` / `es` / `fr` / `de` / `ru` / `pt`，共 8 种；`getSnapshot().locales` 是可查询的列表（设置里的语言菜单就是它）。浏览器标签先精确匹配 id，再匹配主语言子标签，所以 `zh-CN` → `zh`、`en-US` → `en`。缺 key 时沿 active → fallback → `en` 查找，仍缺才显示 key；实测在 ja 下插件没有 ja 字典，四个断言点全部显示英文而不是中文或 key。没有另钉 `locale/index.json`，清单以宿主 `locales` 为准。
- **组件统一用宿主注入的 `t`**：凡是能声明 `locale: SLOT_LOCALE_NAMESPACE` 的 slot 注册都声明；`ProjectPanel`、会话节点气泡、看板面板与卡片详情由此拿到当前语言的 `t`，切换语言时重新渲染。
- **注册期文案用 `ctx.locale.bind`**：tab 类型定义、guide 条目的 `title` / `description`、左栏 footer 的 `label` 都是 thunk，宿主每次投影重读；`bind` 返回的函数在调用时读当前语言，切语言后不必重新注册。
- **tab chip 单独接一个标题席位**：宿主在打开 tab 时把 `title` thunk 的结果写进布局记录，只靠 thunk 的话切语言仍停在打开时的快照。插件在 `sidebar.right.pane.tab.title` 按 definition id 注册自己的标题组件，让常驻标签跟着语言走。
- **纯函数改为收 `t`**：`validateProjectName`、`planProjectRename`、`defaultProjectName`、`openLeaderSession`、`buildProjectMenuItems`、`describeProjectRemoval`、`describeDeletionNotice`、`statusLabel`、`describeCardRemoval`、`foldRows` / `foldSessions` / `foldDoneCards`、`formatBubbleClock` 不再产出中文常量。测试从真实字典取译文（`tests/helpers/locale.js`），不另抄一份期望文本。
- **项目通道错误只留 code**：`ProjectRemoteError` 带 `remote-missing` / `namespace-missing` / `call-failed`，`projectRemoteErrorText` 在 `ProjectPanel` / `Board` 按 `t` 映射；左栏未就绪状态只显示 `project.remoteNotReady`，详情进日志。宿主 `result.error.message` 原样放在 `detail` 并附在 toast 句尾——它是宿主文案，不在客户端翻译。
- **共享链接校验只留 code**：`normalizeLinkDrafts` 返回 `{ code, params }`，编辑器用 `LINK_ERROR_KEYS` 映射到 `card.links.error.*`；宿主写通道只把 code/params 拼进自己的错误，不再产出中文界面文案。
- **门禁**：`scripts/verify-locales.mjs` 检查各语言 `ui` 键集完全一致、占位符一致、无空值、无未使用 key、生成物最新，并扫描 `src/client/**` 的字符串字面量：用户可见 CJK 必须为 0；内部日志/effect 名/开发期异常按「文件 + 原文」登记，新增一条必须显式加进清单。`src/client/locales.generated.js` 与注释/测试不在扫描内。
- **`zh` 是键集事实来源**：`tests/locales.test.js` 与门禁都从生成字典取键；`en` 是回退语言，缺 `en` 生成器直接报错。

## Alternatives considered

- **把界面文案塞进 `locale/*.json` 的 `meta`**：不可行，宿主 `package-meta.ts` 只读 `title` / `description`，运行时不读界面字符串；所以同一文件分 `meta` / `ui` 两个区。
- **组件里保留中文兜底**：`typeof t === 'function' ? t(key) : '中文'` 会让英文界面在 t 缺失时静默露出中文；声明 `locale` 后 `t` 是契约的一部分，缺了就该炸。
- **每个组件自带一份字典**：键名与译文各写一份，改一处漏一处；单文件字典加键集门禁能机械发现漏翻。
- **监听 `locale/change` 重新注册 tab**：宿主没有给 tab 类型重新注册的扩展点，重注册还会把已打开的布局打乱；thunk + title 席位即可。
- **打包时生成字典**：`npm pack`/宿主安装不保证跑构建；生成物入库并在 `check` 里比对，代价只是提交一个生成文件。
- **给 `project-remote.js` 就地翻译**：客户端拿不到宿主的 `t`；改成错误码后在组件里映射，才能跟随运行时语言。
- **继续把共享链接校验当宿主文案**：编辑器会直接显示它；改成 `{ code, params }` 后两端共用判定、界面各自翻译。
- **把宿主 `result.error.message` 也翻译**：宿主业务原因可能来自任意宿主模块，客户端没有字典；保持原样并作为 detail 展示，插件自有前缀才翻译。

## Consequences

- 新增或改动任何用户可见文案，只改 `locale/<code>.json` 并重建生成物；漏改另一种语言、漏占位符、留空值、留下未使用 key 或硬编码中文，`npm run check` 会红。
- 新增语言只需加 `locale/<code>.json`；但宿主只有注册了对应 locale，运行时才会选中它，否则按 fallback 链走英文。
- 左栏项目通道未就绪时不再附带原始错误文本；排查看 `remoteCtx.logger.warn`。toast 里仍可能看到宿主给的业务原因（宿主语言），这是宿主文案的边界。
- `card-links.js` 的错误从字符串变成对象；宿主写通道与编辑器的调用点都要按 `code` 读取，旧字符串判定已全部移除。
- tab chip 多一个按 `PLUGIN_ID` 注册的标题席位；宿主没有该席位时仍回落到打开时的快照。
- 看板已完成区的中文折叠文案从「展开其余 N 个卡片」改为「展开其余 N 张卡」，英文语法也随之修正。
- `bubble-clock.js` 不再固定中文形态；模块头注释同步删掉「本仓不做多语言」。

收益：英文界面里插件自己的所有常驻文案（右栏 tab、左栏区块、看板、详情、气泡、链接校验、通道错误）都跟随界面语言，漏翻由生成器 + 门禁兜住。

## Testing

- `tests/locales.test.js`（生成字典键集/占位符/空文案）、`tests/card-links.test.js`（错误码与参数）、`tests/client-project-remote.test.js`（错误码、映射与宿主 detail）、`tests/projects-remote.test.js`（宿主写通道拒绝非法链接）。
- `tests/e2e/i18n-english.e2e.js`：`locale: 'en-US'` 起真实宿主，断言左栏标题 `Projects`、guide 入口 `Board`、看板 tab chip `Board`、空看板 `No cards yet`，并断言这些区域不含 CJK。
- `tests/e2e/i18n-switch.e2e.js`：不刷新页面，从 zh 打开设置，断言宿主语言菜单 8 项；切 en 后 `Projects` / `Board` / `No cards yet` / 复制按钮 `Copy` 全部变化；切 ja（插件无 ja 字典）四项仍为英文，证明宿主 `ja → en` 回退；切回 zh 全部恢复且 `<html lang>` 回到 `zh-CN`。
- `tests/e2e/i18n-link-editor.e2e.js`：英文宿主里把链接 URL 改成 `javascript:`，编辑器显示 `card.links.error.invalidUrl` 的英文文案，且不含 CJK。
- 门禁双向验证：临时删 `locale/en.json` 的一个 key、在 `src/client/board.js` 塞一个中文字面量，`scripts/verify-locales.mjs` 分别变红；还原后通过。
- 审查修复的英文 UI 证据：e2e 断言看板、项目区块、worker 气泡复制按钮与链接编辑器无 CJK；`projectRemoteErrorText` 单测覆盖左栏/ toast 前缀的英文映射。宿主 `result.error.message` 仍可能是宿主语言，这是文档化的边界。
