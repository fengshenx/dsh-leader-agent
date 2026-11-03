# 新项目的引导卡改为「先讲用法、再问是否初始化」

## 背景

引导卡（#87）的动作是替用户发一句 `guide.intro.prompt`。新项目没有 `LEADER.md`，leader 会话的提示词里没有任何项目身份，模型只能按宿主默认人格回答——用户点「让它介绍一下自己」，实际收到的是 DeepSeek Harness 的自我介绍。

根因有两层：那句话没有给模型任何项目上下文；`init-project` skill 当时只负责把工程约定写进 `AGENTS.md`，没有任何东西告诉模型「这个项目还没有两份手册、该怎么介绍、该不该写」。

## 决策

### 用户消息只发一句触发语，作答要求走 `LEADER.md` 的运行时上下文

`guide.intro.prompt` 缩成一句：「这个项目还没配置，先讲讲 dsh-leader-kit 怎么用。」它在对话里显示为用户消息，长指令（解释什么、问什么、确认前不写文件）放进运行时上下文：`renderInitializationHint`（`src/host/leader-context.js`）在 `LEADER.md` 缺失时取代手册正文，告诉模型按三步回答，并限定触发面——用户直接派活时不打断、问过没答不重复追问。

选注入而不是把长文本塞进消息：用户消息是对话的一部分，几百字的「你是这个项目的 leader……」以用户口吻出现，观感像自言自语；而注入项每轮**求值**、文本变化才追加一份新快照（不是每轮往上下文里再塞一份文本），手册建好后这段提示自动消失，不需要额外的「已提示过」状态。

文件读失败（EISDIR、EACCES）仍返回空串：那不是「没初始化」，提示用户去建一个已经存在的文件只会误导。

三种「没手册」分开说（`renderInitializationHint`）：文件不存在、文件存在但只有空白、旧名手册有内容。前两种问的是不同的事（建文件 / 补内容），混成一句会让模型对着一个已经存在的空文件说「还没有」，甚至去重复创建。第三种根本不该问——`loadLeaderManual` 会回落到旧名正文，hint 里再显式判一次，保证两个函数各自独立调用时不会给出相反结论。

### 空白的新版不遮蔽旧名手册

`LEADER.md` 存在但只有空白、`COORDINATOR.md` 有内容时，`loadLeaderManual` 回落到旧名正文并记一条日志，而不是把空的新版当答案。空文件不是手册，让它遮蔽旧名等于「升级到空 `LEADER.md` 就静默失去注入」——这类事故用户看不到任何报错。两版都有内容时仍旧以新版为准（内容不一致另报一条）。

### 用户拒绝初始化后写标记文件，提示不再出现

拒绝只发生一次，但进程重启就丢，每轮重新问一遍是不可接受的噪声。标记落成插件数据域里的空文件：`<dsh home>/dsh-leader-kit/init-declined/<目录名>-<哈希>`（`src/host/init-declined.js`），`applyLeaderContext` 把 `isDeclined` 与 `declinedFileOf` 传进渲染层，提示第 4 步给出**绝对路径**让模型直接建。「拒绝过」的判定只看文件是否存在，所以删除后下一轮求值就恢复提示，不用重启。

一度把标记放在项目目录（`.dsh-leader-kit/init-declined`），审查否掉了：项目目录是用户的 git 仓库，实测 `git status` 会多出 `?? .dsh-leader-kit/`，`git add -A` 会把这个空文件提交进去，而插件没有、也不该有替用户往仓库里立 `.gitignore` 的权力。数据域方案多出来的成本只是渲染入口多两个回调——`renderInitializationHint` 本来就收 `directory`，传一个 `isDeclined(directory)` 与一个路径函数等价。

文件名带目录名是为了人工排查（只看哈希分不出是哪个项目），哈希取项目目录绝对路径的 sha256 前 12 位，同名仓库不会互相覆盖。代价（模型没写标记就再问一次、拒绝是项目级不按会话分）记在 `docs/limitations.md`。

### 默认槽位从三角色改为两角色

`DEFAULT_SLOT_NAMES` 去掉 `discuss`，只留 `dev` / `review`。需求讨论是 leader 派工前自己做的判断，不值得占一个执行者槽位；沿用三角色会让没写 `SLOTS.md` 的项目默认多出一个没人用的角色。

边界：只影响**零合法槽位时**的回落默认值。项目 `SLOTS.md` 里显式声明的 `## discuss` 节照常解析与注入（本仓根的 `SLOTS.md` 已同步删掉该节）；内置翻译 `slot.discuss` 保留在 `src/client/locales.js`，用户自己加回该槽位时卡面仍有中文名。

这条产品口径与引导卡无直接关系，同一 PR 收口是因为骨架（`init-leader-kit/references/SLOTS.md`）要按两角色写，拆成两个 PR 会让骨架在两次提交里各改一遍。审查时单独标注过，可随时拆出去。

### 骨架随包分发，放在 `init-leader-kit` skill 的 `references/`

骨架是 `references/LEADER.md` 与 `references/SLOTS.md`，随 `.agents/skills/**` 进 npm 包，`package.json` 不用改 `files`。模型加载 skill 时拿到 `resourceBase`（skill 目录），直接用文件工具读这两份，不需要再猜插件安装路径。

否决的方案是新增一个 `read_manual_template` 工具：它只是为了把两段静态文本递给模型，却给每个会话的工具面永久加一项；初始化是一次性动作，skill 的按需加载才是对的载体。

### 不自动写文件，空目录写骨架并提问

插件不在项目注册时写任何文件。用户确认后由 skill 写：先把 `AGENTS.md` 的受管区块并入，再按项目实际改写两份手册。目录是空的就不编造——写带 TODO 的骨架，并把还缺的三个问题（项目做什么、什么算交付、有哪些硬约束）问清楚；这比生成一份看起来完整、实际是通用道理的 `LEADER.md` 有用。

### skill 从 `init-project` 改名 `init-leader-kit`

`init-project` 太通用，容易和其他插件的同名 skill 撞；`init-leader-kit` 一眼能看出归属。skill 是 bundled provider（`rank: 600`），不落 `~/.dsh/skills`，项目内同名副本仍优先。改名对 0.1.1 已装用户是可见变化（skill 列表里名字变了），可接受：名字只影响模型发现，不影响已写入项目的文件。

## 边界

- 初始化提示只在「`LEADER.md` 不存在或只有空白，且 `COORDINATOR.md` 也没有正文」时注入；项目已有手册（任一文件名）就不再出现。
- 空白 `LEADER.md` 与缺失 `LEADER.md` 的提示文案不同：前者让模型补内容，后者才让它建文件。
- **清空新版 `LEADER.md` 会让旧名手册「复活」**：回落在判定顺序上就是把空的新版当没有。按旧名初始化过的项目里，用户如果选择清空而不是删除 `LEADER.md`，`COORDINATOR.md` 的正文会重新进入注入——这是「空文件不是手册」的必然代价，日志会报一条说明按旧名读取。想彻底停用就把两个文件都删掉。
- 提示不打断正常派工：用户直接下任务时模型按常规流程干活，不主动兜售初始化。
- 拒绝初始化后靠数据域里的标记静音（`<dsh home>/dsh-leader-kit/init-declined/`）；模型没写标记则新会话会再问一次（`docs/limitations.md` 有同一条）。
- 引导卡的 `blank` 判据不变：消息发出后卡片消失，关掉的状态按 leader 会话 id 存 localStorage。
- 空目录的骨架带 `TODO`，是给人填的；skill 明确不要用通用道理填满。

## 验证

- `tests/leader-context.test.js`：新增「项目还没有手册时注入初始化提示」（断言含 `## 项目待初始化`、`init-leader-kit`、`不要创建或修改任何文件`、`用户直接派活时不要打断`）、「已有 `SLOTS.md` 只缺 `LEADER.md` 时措辞不同」、「手册存在时不出现初始化提示」、「仅空白 `LEADER.md` 时提示说的是补内容」、「只有 `COORDINATOR.md` 时按旧名注入」「空 `LEADER.md` + 有内容 `COORDINATOR.md` 时回落到旧名」「拒绝后不再注入、删掉标记下一轮恢复（断言提示里给出数据域绝对路径）」；原「缺失返回空串」改为只断言 `loadLeaderManual`。
- `tests/init-declined.test.js`：五例——标记落数据域而非项目目录、同一目录稳定且不同目录（含同名仓库）分开、无标记不算拒绝、写入后判定为已拒绝且删除即恢复、目录名含中文与空格时文件名仍合法。
- 双向验证（撤销 → 对应用例变红 → 还原 → 27 例全绿）：把「空白/缺失」判定改回只说「还没有」→ 仅空白用例红；把 `loadLeaderManual` 的新版判据改回 `first.body !== undefined`（空新版遮蔽旧名）→ 回落用例红；把 `isDeclined` 短路成 `false` → 拒绝用例红。
- `tests/guide-card-logic.test.js`：新增「开场正文只发一句触发语」——断言两句 `guide.intro.prompt` 都含 `dsh-leader-kit`、不含 `LEADER.md`、长度小于 80。
- `tests/skills.test.js` / `tests/leader-wiring.test.js` / `tests/pack-manifest.test.js`：skill 名单与包内路径同步为 `init-leader-kit`；新增「初始化骨架默认只含 dev 与 review 两个槽位」。
- `tests/slots.test.js`：新增「默认槽位只有 dev 与 review」，锁住回落口径（讨论由 leader 自己做，不占槽位）。
- `npm run check`：1009 用例通过（16 跳过），99 文件语法通过，13 篇 standing docs 在预算内。`limitations.md` / `usage.md` 的天花板按 5% 余量重算（6900 / 5600）：两条边界是使用者与后续维护都要读到的事实，压缩会丢信息。
