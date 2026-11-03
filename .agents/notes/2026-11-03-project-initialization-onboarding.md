# 新项目的引导卡改为「先讲用法、再问是否初始化」

## 背景

引导卡（#87）的动作是替用户发一句 `guide.intro.prompt`。新项目没有 `LEADER.md`，leader 会话的提示词里没有任何项目身份，模型只能按宿主默认人格回答——用户点「让它介绍一下自己」，实际收到的是 DeepSeek Harness 的自我介绍。

根因有两层：那句话没有给模型任何项目上下文；`init-project` skill 当时只负责把工程约定写进 `AGENTS.md`，没有任何东西告诉模型「这个项目还没有两份手册、该怎么介绍、该不该写」。

## 决策

### 用户消息只发一句触发语，作答要求走 `LEADER.md` 的运行时上下文

`guide.intro.prompt` 缩成一句：「这个项目还没配置，先讲讲 dsh-leader-kit 怎么用。」它在对话里显示为用户消息，长指令（解释什么、问什么、确认前不写文件）放进运行时上下文：`renderInitializationHint`（`src/host/leader-context.js`）在 `LEADER.md` 缺失时取代手册正文，告诉模型按三步回答，并限定触发面——用户直接派活时不打断、问过没答不重复追问。

选注入而不是把长文本塞进消息：用户消息是对话的一部分，几百字的「你是这个项目的 leader……」以用户口吻出现，观感像自言自语；而注入项每轮重新求值，手册建好后自动消失，不需要任何状态标记。

文件读失败（EISDIR、EACCES）仍返回空串：那不是「没初始化」，提示用户去建一个已经存在的文件只会误导。

### 骨架随包分发，放在 `init-leader-kit` skill 的 `references/`

骨架是 `references/LEADER.md` 与 `references/SLOTS.md`，随 `.agents/skills/**` 进 npm 包，`package.json` 不用改 `files`。模型加载 skill 时拿到 `resourceBase`（skill 目录），直接用文件工具读这两份，不需要再猜插件安装路径。

否决的方案是新增一个 `read_manual_template` 工具：它只是为了把两段静态文本递给模型，却给每个会话的工具面永久加一项；初始化是一次性动作，skill 的按需加载才是对的载体。

### 不自动写文件，空目录写骨架并提问

插件不在项目注册时写任何文件。用户确认后由 skill 写：先把 `AGENTS.md` 的受管区块并入，再按项目实际改写两份手册。目录是空的就不编造——写带 TODO 的骨架，并把还缺的三个问题（项目做什么、什么算交付、有哪些硬约束）问清楚；这比生成一份看起来完整、实际是通用道理的 `LEADER.md` 有用。

### skill 从 `init-project` 改名 `init-leader-kit`

`init-project` 太通用，容易和其他插件的同名 skill 撞；`init-leader-kit` 一眼能看出归属。skill 是 bundled provider（`rank: 600`），不落 `~/.dsh/skills`，项目内同名副本仍优先。改名对 0.1.1 已装用户是可见变化（skill 列表里名字变了），可接受：名字只影响模型发现，不影响已写入项目的文件。

## 边界

- 初始化提示只在 `LEADER.md` 缺失（含只有空白）时注入；项目已有手册就不再出现。
- 提示不打断正常派工：用户直接下任务时模型按常规流程干活，不主动兜售初始化。
- 引导卡的 `blank` 判据不变：消息发出后卡片消失，关掉的状态按 leader 会话 id 存 localStorage。
- 空目录的骨架带 `TODO`，是给人填的；skill 明确不要用通用道理填满。

## 验证

- `tests/leader-context.test.js`：新增「项目还没有手册时注入初始化提示」（断言含 `## 项目待初始化`、`init-leader-kit`、`不要创建或修改任何文件`、`用户直接派活时不要打断`）、「已有 `SLOTS.md` 只缺 `LEADER.md` 时措辞不同」、「手册存在时不出现初始化提示」；原「缺失返回空串」改为只断言 `loadLeaderManual`。
- `tests/guide-card-logic.test.js`：新增「开场正文只发一句触发语」——断言两句 `guide.intro.prompt` 都含 `dsh-leader-kit`、不含 `LEADER.md`、长度小于 80。
- `tests/skills.test.js` / `tests/leader-wiring.test.js` / `tests/pack-manifest.test.js`：skill 名单与包内路径同步为 `init-leader-kit`。
- `npm run check`：998 用例通过（16 跳过），98 文件语法通过，13 篇 standing docs 在预算内。
