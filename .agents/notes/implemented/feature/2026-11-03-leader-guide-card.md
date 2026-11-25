# Agent Note: leader 会话的一次性引导卡

Status: implemented

## Problem

「加项目」会当场建一个 leader 会话，界面上一句话都没有：用户不知道要先写 `LEADER.md` 与 `SLOTS.md`，也不知道项目行就是 leader 的入口。会话空态是刻意留白的——第三方会话视图目标只把会话顶进 active 形态、不产出内容，缺的是只在最需要的那一次说清下一步的提示。

## Decision

- **判据用宿主会话快照的 `blank`**，不用消息计数或时间窗：`conversation.input.dock` 的 owner 直接带当前会话快照，`blank` 是宿主自己的「这个会话还没有对话」口径，rc.2 已有；宿主在首个 prompt 被接受时翻假，本地发送即生效，跨进程重启后同一空会话仍判为 blank。
- **关闭状态按 leader 会话 id 存 localStorage**（`dsh-leader-agent.guide.dismissed.<sessionId>`）：仓外插件不能新增 session event 类型，一次性提示也不该写进会话记录；项目 id 要在浏览器侧再拉一次才能拿到，会话 id 本地已有。换 leader 会话引导会再出现一次——那正是该重新提醒的时候。
- **文案走 `ctx.locale.register` 的同一命名空间**（`src/client/locales.js`），不往 `locale/*.json` 里塞：宿主只从那里读插件显示名 title / description，界面字符串走 locale 注册。
- **唯一动作是「替用户发一条消息」**：`setDraft(prompt)` + `submit()`，与手敲回车等价——点下去会话里多一条 user 消息、走一轮标准模型回合，卡片随后因 `blank` 翻假消失。不是预填、不是复制、不是 toast；输入机缺失时不渲染按钮，而不是画一个点了没反应的按钮。
- **按钮只发一句触发语**（含「不读 / 不改 / 不建」守卫），作答要求（先解释怎么工作、再问是否初始化两份手册、确认前不写文件）进 leader 运行时上下文的初始化提示；示例建卡派工也只在初始化提示注入时发生（项目还没有 `LEADER.md` 或旧名 `COORDINATOR.md` 的正文），已有手册的项目点引导只讲用法，不建卡派工。理由与取舍见 [2026-11-03-project-initialization-onboarding.md](2026-11-03-project-initialization-onboarding.md)：用户消息只该是一句人话，长约束进提示词。
- **形态取单行提示条，几何与输入框同源**：宽度取输入框外壳同一个 `--dsh-composer-card-max-width` token 并居中，同时减掉宿主的 `--dsh-composer-side-clearance`——输入框在外层 root 上按这条 clearance 内缩，而 dock 槽位在 padding 之外，不减就会在窄窗口比输入框两边各宽一截；圆角同取面板圆角，材质刻意比输入框轻一档且不叠投影（叠在一起才不会被读成两个输入框）；字号回到宿主正文档（首版的元信息字号做提示正文偏小）；布局是「图标 + 标题 / 步骤 + 右侧动作」三段 flex，窄窗口下正文先换行、动作不被挤出；动作换宿主 `Button`，图标用 `productIcon('checklist-outline')`（rc.2 的 primitives 没有通用图标族，内联宿主 artwork 是下限版本唯一稳妥的来源）；文案折成一行并用 `·` 分隔，删掉给 leader 看的执行细节。
- **独立 dock 条目 `dsh-leader-agent-guide`**：与 leader 视图入口共用 `conversation.input.dock`，不满足条件时返回 null、不占空间；官方空会话形态与第三方视图目标的行为都不改。
- **文档入口整条去掉**：只保留一个开场动作，不做复制路径、也不做外链；`docs/limitations.md` 里描述已删行为的限制一并删除——留着只会误导。

## Alternatives considered

- **用消息计数或时间窗判空**：宿主快照的 `blank` 就是「还没有对话」的权威口径，本地发送即翻假；不用自造判据。
- **把关闭状态写进 session event 或项目存储**：仓外插件不能新增事件类型，一次性提示也不该进会话记录；按会话 id 存 localStorage。
- **把界面文案塞进 `locale/*.json`**：那里是包元信息（市场卡片标题/描述）；界面字符串走 `ctx.locale.register`。
- **做成静态提示 + 复制路径 / 外链**：用户要的是「让它自己介绍」，复制路径还得自己粘；唯一动作改成替用户发一句开场消息。
- **把长约束写进用户消息**：几百字以用户口吻出现像自言自语；触发语进消息，约束进运行时上下文。

## Consequences

- 只对 leader 会话生效；worker 会话与普通会话没有变化。
- 卡片渲染本身不写转录、不产生模型调用、不发消息；唯一会发消息的是用户点「了解怎么用」，走与回车相同的提交路径。
- localStorage 私有模式：读抛错按「没关过」处理（卡片再出现一次），写抛错静默丢弃（这次不记住）。
- 引导条上没有外链、没有剪贴板动作；输入机能力判定只有一处（`canSendIntro`），渲染守卫与发送路径都调它。
- 换 leader 后引导会再出现一次，没有做成「项目级只提示一次」。

收益：新项目第一次打开就有一条能点的引导，点一下 leader 就开始讲用法并问是否初始化。

## Testing

`tests/guide-card-logic.test.js` 与 `tests/e2e/guide-card.e2e.js`；e2e 在 640px 视口下用最小几何守卫钉住引导条与宿主输入框的左右边缘（容差 0.5px），只守已修的对齐 bug，不测颜色/圆角。双向：把 `dismiss` 的 `setItem` 改成空操作 → e2e「重载后不该再出现」当场红；把 `sendIntroPrompt` 改成空实现 → 用户气泡断言超时红；把宽度改回 `100%` → 窄窗口几何守卫红。还原后全绿。
