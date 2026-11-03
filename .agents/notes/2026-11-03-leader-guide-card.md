# leader 会话的一次性引导卡

**状态**：implemented（2026-11-03）
**范围**：`src/client/{guide-card,guide-card-logic}.js`、`src/client/index.js`、`src/client/{locales,board-styles}.js`、`tests/guide-card-logic.test.js`、`tests/e2e/{guide-card.e2e.js,instance.mjs}`、`docs/`

## 背景

「加项目」会当场建一个 leader 会话，界面上一句话都没有：用户不知道要先写 `LEADER.md` 与 `SLOTS.md`，也不知道项目行就是 leader 的入口（issue #87）。会话空态是刻意留白的——本 bundle 注册第三方会话视图目标只把会话顶进 active 形态，不产出内容、不塞开场白。缺的是**只在最需要的那一次**说清下一步的提示。

## 决策

### 判据用宿主会话快照的 `blank`，不用消息计数或时间窗

`conversation.input.dock` 的 owner 是 `InputZone { session: SessionSnapshot; input: InputState }`，组件拿到的 props 里直接有当前会话快照；`SessionSnapshot.blank` 就是宿主自己的「这个会话还没有对话」口径。下发时长按 `engines.dsh` 下限核对过：`dsh-v0.2.1-rc.2` 的 `packages/api/session-controller/src/client/contract/snapshot.ts:85` 已有 `blank`，`packages/client/ui-conversation/src/client/contract/slots.ts:384` 的 `InputZone` 也已是这个形状。所以 issue 里「先读消息计数、再退时间窗」的两条退路都没有用上。

`blank` 比「消息数」更贴语义：宿主在首个 prompt 被接受时把它翻假（`sessions/manager.ts` 的 `handleBlank(false)`），本地发送即生效，不比等 durable 事件晚。测试里也验证了它跨进程成立——重启实例后同一个空会话仍被判为 blank，卡片照常出现。

### 关闭状态按 leader 会话 id 存 localStorage

仓外插件不能新增 session event 类型，一次性提示更不该写进会话记录（写进去就不满足「引导出现期间会话事件数为 0」）。键是 `dsh-leader-kit.guide.dismissed.<sessionId>`：项目 id 要在浏览器侧再拉一次 `projects/list` 才能拿到，而会话 id 正是触发条件的另一半，本地已有；换了 leader 会话引导会再出现一次——那正是该重新提醒的时候。

### 文案走 `ctx.locale.register` 的同一命名空间，不往 `locale/*.json` 里塞

issue 要求「文案进 `locale/zh.json` / `locale/en.json`」，但宿主的 `package-meta.ts` 只从 `locale/*.json` 读 `title` 与 `description`（插件显示名，出现在插件管理器里），界面字符串走 `ctx.locale.register(namespace, { zh, en })`。本仓已有的界面文案就在 `src/client/locales.js` 这份字典里，引导卡的 8 个键追加进同一个命名空间，`locale/*.json` 保持只放显示名。

### 唯一动作是「替用户发一条消息」，走宿主的输入机

按钮的定位是**替用户发出那条自我介绍请求**，与用户手敲回车等价：点下去之后会话里多一条 user 消息、走一轮标准模型回合，卡片随后因为 `blank` 翻假而消失。不是预填、不是复制、不是 toast。

通道在宿主 rc.2 就有：会话作用域槽位的标准 props 里合并了 `inputActions: InputActions`（`packages/client/ui-conversation/src/client/contract/input.ts:247`），`submit()` 的注释写着「Enter submission（adjudication / claim transaction / default sink inside）」——就是回车那条路径。实现是 `setDraft(prompt)` + `submit()`（`sendIntroPrompt`）。输入机缺失时**不渲染这个按钮**，而不是画一个点了没反应的按钮。

文案也跟着改成祈使句（读出「发消息」）：中文「让它介绍一下自己」，英文「Ask it to introduce itself」；发出去的正文是 `guide.intro.prompt`。候选：`让它先做个自我介绍`、`对它说：介绍一下你自己`——都更短或更像对话，但按钮上塞对话句式读起来拐，选了最短的祈使句。

首版这条动作是「看上手文档 = 复制路径 + toast」，用户判定没意义后改过一版外链 GitHub 文档页，随后定稿为**只保留自我介绍**——文档入口整条去掉，`docs/limitations.md` 里那条「只能复制路径」的限制也一并删掉（行为已不存在，留一条描述已删行为的限制只会误导）。

### 形态取单行提示条，几何与输入框同源

首版做成了大卡片（全宽、134px 高、12px 正文），被用户否掉四条：太笨重、字太小、比输入框宽、右侧大片空白。重做时先量了宿主的基准：

- 输入框外壳 `uV2eYG_card` 的规则是 `width:100%; max-width:var(--dsh-composer-card-max-width); border-radius:var(--dsw-radius-panel); background:var(--dsw-specific-input-major); box-shadow:var(--dsw-elevation-soft); font-size:var(--dsh-content-font-size,14px)`。引导条直接取**同一个宽度 token**（`--dsh-composer-card-max-width`）+ `margin-inline:auto`，宽度与左右边界就和输入框逐像素一致（实测 1440 宽下 774.4 / 774.4，1280 宽下 712 / 712，差值 0）。
- 圆角同取 `--dsw-radius-panel`（28px）。材质刻意比输入框**轻一档**：输入框是白面 + `elevation-soft`，引导条取 `--dsw-alias-interactive-bg-hover`（浅色 rgba(38,49,72,.06)、深色 rgba(255,255,255,.08)）且不叠投影——两块叠在一起才不会被读成两个输入框。
- 字号回到宿主正文档：标题 `--dsw-font-s-strong-14-*`（14/22/500），步骤 `--dsw-font-xs-13-*`（13/20）。首版的 12px 落在宿主「元信息」档位上，做提示正文偏小。
- 布局改成 `图标 + (标题/步骤) + 右侧动作` 的三段 flex：正文列 `flex:1 + min-width:0` 吃掉动作左侧全部宽度，右侧不再有空白；窄窗口下正文先换行，动作不被挤出。
- 动作换成宿主的 `Button`（`size: 'sm'`、`variant: 'outline' | 'ghost'`），不再自绘文字按钮。图标用 `productIcon('checklist-outline')`：rc.2 的 primitives 只导出几个状态图标，没有通用的 `Icon*OutlineRegular`，本仓内联的宿主 artwork 路径是下限版本唯一稳妥的来源。
- 文案从三行折成一行 `·` 分隔，并删掉「先读 `playbooks/program.md`」——那是给 leader 的执行细节，对新用户是噪音，文档里有。

### 独立 dock 条目，不动视图目标与官方空会话形态

新增注册项 `dsh-leader-kit-guide`（`order: 90`），与 leader 视图入口（`order: 100`）共用 `conversation.input.dock`。条目渲染不满足条件时返回 null，不占空间；官方空会话形态、第三方视图目标的行为都没有改。

## 边界

- 只对 leader 会话生效；worker 会话与普通会话没有变化（`leaderSessionIndex` 不含它们）。
- 卡片不写转录、不产生模型调用、不自动发消息——e2e 直接断言模型请求数为 0、会话日志里没有 `user/message`。
- localStorage 私有模式：读抛错按「没关过」处理（卡片再出现一次），写抛错静默丢弃（这次不记住），两处都在单行注释里写了原因。
- 「看上手文档」只复制路径：headless 里没有剪贴板授权，e2e 不断言这条按钮的剪贴板效果，只覆盖失败提示的分支（单测）。
- 换 leader 后引导会重新出现一次（按会话 id 分键的直接后果），没有做成「项目级只提示一次」。
- 文档落位：交互行为进 `docs/usage.md` 的项目管理节，能力缺口（拿不到打开本地文件、包内不带 `docs/`）进 `docs/limitations.md`，注入面在 `docs/architecture.md` 的客户端表里加一行。`docs/usage.md` 的天花板从 5350 抬到 5400（实测 5112，余 5.3%）：引导卡是使用者可见的新交互，归这一层，压缩到 5% 以内会把行为说明削成标题。

## 验证

- 单测 `tests/guide-card-logic.test.js` 14 条：触发条件矩阵（含 undefined 输入）、键的稳定性、存储缺失/抛错、复制成功与两种失败路径。
- `npm run check` 全绿：989 个用例通过（16 条 Windows 相关在非 Windows 上 skip），70 个源文件、54 个被单测加载（46 个行覆盖 100%）、16 个登记为单测不可加载（新增的 `src/client/guide-card.js` 在册，理由写明组件归 e2e）；13 篇 standing docs 都在天花板内。
- `npm run e2e` 3 条全绿，新增场景 `tests/e2e/guide-card.e2e.js`（约 8 秒）：起实例拿宿主自建的空会话 → 停 → 写 `projects.json` → 同一数据根再起一次 → 点项目行后卡片出现（标题文案、模型请求数 0、日志无 `user/message`）→ 点「知道了」后重载不再出现 → 新浏览器上下文里发首条消息后卡片消失。
- 双向验证：把 `dismiss` 的 `setItem` 改成空操作后重跑 e2e，「重载后不该再出现」当场变红（locator 14 次仍解析到可见的卡片）；还原后变绿。
- 真机读数（探针，`/tmp` 临时脚本，已删）：关闭后 `localStorage` 只有一条 `dsh-leader-kit.guide.dismissed.session-<id>`；首条消息后模型请求 2 次（场景 + 标题），与「引导期间 0 次」对照。
- 视觉读数（e2e 断言 + 探针，1440×900 与 1280×900 两种窗口、浅色与深色两套主题）：
  - 卡片 `w=774.4 / x=469.3 / right=1243.7`，输入框外壳 `w=774.4 / x=469.3 / right=1243.7`——宽、左、右三处差值均为 0；1280 宽下两侧同为 712，差值同样为 0（同一个 `--dsh-composer-card-max-width` token，窗口收窄时一起收）。
  - 卡片高 64px（首版 134px），圆角 28px 与输入框一致；标题 14/22/500、步骤 13/20；按钮 28px 高、8px 圆角（宿主 `Button` 的 `sm` 规格）。
  - 深色主题：卡片底色 `rgba(255,255,255,0.08)`、标题 `rgb(249,250,251)`、输入框 `rgb(44,44,46)`——全部由 token 得出，宽度与边界与浅色一致。
- 点击验收：e2e 断言 ① 引导条 locator 变 detached；② 宿主 user 气泡容器 `[data-chat-flow-kind="user"]` 里存在一个叶子元素、其文本恰为 `guide.intro.prompt`（气泡容器还含时间戳，所以不用整块 innerText 相等，也不用「文本包含」——引导条自己的文案里有同一句话，会被自己命中）；③ 会话日志出现这条消息；④ 模型请求 +1。双向验证：把 `sendIntroPrompt` 改成空实现后，气泡断言当场超时变红；还原后全绿。
  - 这三条几何/字号指标已写进 e2e 断言（`width/left/right ≤ 1px`、圆角与输入框相等、标题 ≥14px、步骤 ≥13px、高度 ≤80px），双向验证：删掉 `max-width: var(--dsh-composer-card-max-width)` 后断言立即变红（宽度差 378.6px、左右各偏 189.3px），还原后变绿。
