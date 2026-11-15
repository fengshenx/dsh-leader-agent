# Agent Note: 槽位名与显示名分离

Status: implemented

## Problem

槽位名原本同时承担 schema 标识（`SLOTS.md` 分节名、卡片 `slots` 的 JSON 键、槽位注入反查键）与卡面显示名：中文项目要么把中文写进 schema，要么在中文界面看到 `dev` / `review`。中文进标识又不成立——同一份项目配置会被不同语言的协作者共用，标识一旦随显示需求变化，卡片存储、`SLOTS.md` 与注入反查三处都要迁移。**标识是数据，名字是呈现**。

## Decision

- **key**：小写 ASCII slug（`[a-z0-9_-]{1,32}`），仍是 `SLOTS.md` 分节名、卡片 `slots` 键与注入反查键；大小写敏感且只允许小写，避免 `Dev` 与 `dev` 成为两个键。
- **label 的真源是项目配置**：`SLOTS.md` 顶部的 YAML frontmatter 用 `slots.<槽位名>.label` 声明显示名；新增槽位的人自己声明，不依赖插件预置翻译，内置 locale 字典只是默认兜底。
- **协议选 frontmatter，不选节内 `label:` 行**：Markdown 没有条目级元数据的标准，节内自造约定容易与角色正文混淆；frontmatter 是文档元数据的事实标准（GitHub 渲染为表格），元数据与正文分离。解析复用 `src/shared/frontmatter.js`，并扩展为按缩进栈解析嵌套 map。
- **label 的数据通路**：宿主解析 `SLOTS.md` 后由远程方法 `projectSlots(projectId)` 下发（只下发有 label 的槽位），浏览器侧在看板项目复核时取一次，失败静默回落；`SLOTS.md` 改动最多等一个复核周期生效。
- **渲染优先级**：`slotDisplayName(name, labels, t)` = 项目 `label` → 内置 locale 翻译 → 槽位名本身。项目怎么称呼自己的角色，以项目为准。
- **内置 locale 字典**在 `src/client/locales.js`（命名空间 `dsh-leader-agent`，zh / en 覆盖 `discuss` / `dev` / `review`）；看板面板注册时声明 `locale` 席位，宿主注入当前语言的 `t`，语言切换时给新函数引用，`memo` 的卡片组件自然重渲染。
- **注入文本用 key**：角色注入里的「你当前承担「dev」槽位」保持键名，与模型在卡片 `slots` 字段里看到的键一致；label 只服务人看的界面，不进提示词。
- **写卡校验**：`normalizeSlots` 用同一个 `isValidSlotName` 校验槽位名。此前非法名会成功落盘，而 `SLOTS.md` 解析器整节忽略、注入静默变成空串——现在在写入前报错。

## Alternatives considered

- **让槽位名同时当显示名**：中文项目要么把中文写进 schema，要么界面看到 `dev` / `review`；标识与呈现分离。
- **在 `## 槽位名` 节内写 `label:`**：Markdown 没有条目级元数据标准，容易与角色正文混淆；放 frontmatter。
- **只靠插件内置翻译**：项目怎么称呼自己的角色应由项目配置决定；frontmatter 优先、locale 兜底。
- **在卡片 schema 里用 `propertyNames` / `pattern` 校验**：宿主执行子集不支持，整个插件装配会抛错；在 `normalizeSlots` 里校验。
- **把 label 注入提示词**：模型看到的槽位键应与卡片 `slots` 字段一致；label 只服务界面。

## Consequences

- **frontmatter 解析的容错边界**：重复的嵌套容器键合并；同一路径两次给不同值时后者覆盖并记一条冲突（返回 `warnings`）；引号外的「空格 + #」是行内注释，引号内的 `#` 与 `a#b` 属于内容；无值键后紧跟更浅缩进时，键仍归它自己那一层。
- **告警按问题签名去重，不按目录**：零合法节、非法分节名、frontmatter 冲突每轮只报一次，修好又坏会重新报；按目录永久去重会让后续错误彻底沉默（每轮注入与 30 秒复核都读这个文件）。文件不存在不告警。
- **卡片工具 schema 只能用宿主执行子集**：`propertyNames`、`pattern`、对象形式的 `additionalProperties` 会让 `tools.register` 直接抛 `UNSUPPORTED_SCHEMA`（整个插件装配失败）。槽位是 map 形状，只能用 `additionalProperties: true`，名字合法性只在 `normalizeSlots` 里执行。
- **frontmatter 只提供元数据**：`slots` 里声明、但正文没有 `## <槽位名>` 节的槽位不成立；空值、超长、非对象条目与非法槽位名一律按未声明处理，界面回落 locale 或原名。正文里出现的 `label:` 只是普通文本，照常注入模型。
- **`projectSlots` 取不到时回落**：项目不存在、通道失败或返回脏数据都不让看板报错，槽位 chip 继续用 locale 或原名。
- `locale/zh.json` / `locale/en.json` 是**包元信息**（市场卡片的标题与描述），不是运行时 UI 字典；字典只注册 zh / en，其它语言沿宿主回退链到 en。
- 卡面 chip 的 React `key` 仍用槽位键，改名只影响渲染文本，不影响会话绑定与槽位反查。

收益：槽位标识保持稳定 ASCII，显示名可由项目自定义，中文界面不再看到 `dev` / `review`。

## Testing

`tests/frontmatter.test.js`、`tests/slot-labels.test.js` 与 `tests/cards-tools.test.js`。双向：撤掉 `slotDisplayName` 的项目 label 优先 → 「显示名优先级」红；撤掉 `normalizeSlots` 的 `isValidSlotName` → 「拒绝非法槽位名」红；加回 `propertyNames` → 「schema 只用宿主执行子集」红。还原后全绿。
