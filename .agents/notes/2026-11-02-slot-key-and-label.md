# 槽位名与显示名分离

## 背景

槽位名原本同时承担两件事：schema 里的标识（`SLOTS.md` 分节名、卡片 `slots` 的 JSON 键、槽位注入反查键）和卡面上的显示名。结果是中文项目要么把中文写进 schema，要么在中文界面看到 `dev` / `review`。

把中文直接放进标识不成立：同一份项目配置会被不同语言的协作者共用，英文界面的人会看到中文键；标识一旦随显示需求变化，卡片存储、`SLOTS.md` 与注入反查三处都要跟着迁移。**标识是数据，名字是呈现**，两层必须分开。

## 决策

- **key**：小写 ASCII slug（`[a-z0-9_-]{1,32}`），仍是 `SLOTS.md` 分节名、卡片 `slots` 键与注入反查键。大小写敏感且只允许小写，避免 `Dev` 与 `dev` 成为两个键。
- **label 的真源是项目配置**：`SLOTS.md` 顶部的 YAML frontmatter 用 `slots.<槽位名>.label` 声明显示名。新增槽位的人自己声明显示名，不依赖插件预置翻译；插件内置的 locale 字典只是默认兜底。
- **协议选 frontmatter，不选节内 `label:` 行**：Markdown 没有条目级元数据的标准，节内自定义一行 `label:` 是自造约定，混在角色正文里也容易把正文当成元信息。frontmatter 是文档元数据的事实标准（Jekyll / Hugo / Obsidian / Astro 都识别，GitHub 渲染为表格），元数据与正文分离。解析复用 `src/shared/frontmatter.js`，并为它加了按缩进栈解析嵌套 map 的能力（`slots.dev.label` 是两层）。
- **label 的数据通路**：宿主解析 `SLOTS.md` 后由远程方法 `projectSlots(projectId)` 下发（只下发了 `label` 的槽位）。浏览器侧在看板项目复核时取一次，失败静默回落；`SLOTS.md` 改动最多等一个复核周期（30s）生效。
- **渲染优先级**：`slotDisplayName(name, labels, t)` = 项目 `label` → 内置 locale 翻译 → 槽位名本身。项目怎么称呼自己的角色，以项目为准。
- **内置 locale 字典**：`src/client/locales.js`，命名空间 `dsh-leader-kit`，zh / en 两份覆盖 `discuss` / `dev` / `review`。看板面板注册时声明 `locale` 席位，宿主注入当前语言的 `t`；语言切换时宿主给新函数引用，`memo` 的卡片组件自然重渲染。
- **注入文本用 key**：`renderRoleContext` 的「你当前承担「dev」槽位」保持键名，与模型在卡片 `slots` 字段里看到的键一致；label 只服务人看的界面，不进提示词。
- **写卡校验**：`normalizeSlots` 用同一个 `isValidSlotName` 校验槽位名。此前写进非法名会成功落盘，`SLOTS.md` 解析器却整节忽略，注入静默变成空串——现在在写入前报错。

## 边界

- **frontmatter 解析器的容错边界**：重复的嵌套容器键合并（两段 `slots:` 各写各的槽位时不会互相抹掉），同名标量后者覆盖；引号外的「空格 + #」是行内注释，引号内的 `#` 属于内容；无值键后紧跟更浅缩进时，键仍归它自己那一层，不落到顶层。`SLOTS.md` 存在但零合法节时回落默认槽位并告警一次（按目录去重——每轮注入与看板 30 秒复核都会读它，重复告警只会刷日志）；文件不存在不告警。
- **frontmatter 只提供元数据**：`slots` 里声明、但正文没有 `## <槽位名>` 节的槽位不成立——正文才是槽位存在的依据。空值、超长（>64）、非对象条目与非法槽位名一律按未声明处理，界面回落 locale 或原名。正文里出现的 `label:` 只是普通文本，照常注入模型。
- **`projectSlots` 取不到时回落**：项目不存在、通道失败或返回脏数据都不让看板报错；槽位 chip 继续用 locale 或原名。
- `locale/zh.json` / `locale/en.json` 是**包元信息**（市场卡片的标题与描述），不是运行时 UI 字典。运行时文案走宿主 ui-slots 的 locale 命名空间，字典在 `src/client/locales.js`。
- 字典只注册 zh / en 两个基础 locale；其它语言沿宿主回退链到 en。
- 本 PR 前一提交曾短暂允许中文 key，未发布，这里一并回退。存量卡片上的 ASCII 键全部仍在合法集合内，没有迁移动作。
- 槽位键与显示名分离后，**卡面 chip 的 `key` 仍用槽位键**（`board-card.js` 的 React key），改名只影响渲染文本，不影响会话绑定与槽位反查。
