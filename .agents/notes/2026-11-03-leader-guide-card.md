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

### 「看上手文档」复制路径，不做站外链接

第三方 bundle 没有打开本地文件的通道，发布白名单也不带 `docs/`（`scripts/pack-manifest.mjs` 里 `docs/` 整目录被拦）。于是按钮把 `docs/getting-started.md` 写进剪贴板并提示位置：从仓库或用源码安装时路径直接可用，从 npm 装的用户至少知道文档叫什么、在哪一层。剪贴板缺失或被拒时改提示文档位置，按钮不会点了没反应。

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
- 真机读数（探针，`/tmp` 临时脚本，已删）：卡片全文为「这个目录有一个 Leader 了 / 在项目目录写 LEADER.md… 和 SLOTS.md… / 让它加载 leader-mode，先读 playbooks/program.md / 直接说你要做什么——它建卡、派工，右栏「看板」跟进 / 看上手文档 / 知道了」；关闭后 `localStorage` 只有一条 `dsh-leader-kit.guide.dismissed.session-<id>`；首条消息后模型请求 2 次（场景 + 标题），与「引导期间 0 次」对照。
