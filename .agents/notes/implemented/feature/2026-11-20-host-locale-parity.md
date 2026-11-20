# Agent Note: 随包补齐宿主全部语言

Status: implemented

## Problem

上一轮 i18n 收口把界面文案收进 `locale/<code>.json`（见[客户端界面文案收口到 locale 字典](2026-11-20-client-ui-i18n-sweep.md)），但只提供 `zh` / `en`；宿主已注册 8 种语言（`zh` / `en` / `ja` / `es` / `fr` / `de` / `ru` / `pt`）。其余六种语言下插件没有字典，整个客户端沿 fallback 链落到英文：宿主切到日语、西语等语言时，插件自己的 tab、项目区、看板与详情仍是英文。门禁只校验「已提供的语言之间一致」，缺语言本身不会被发现。

## Decision

- 按宿主 catalog 补齐 `ja` / `es` / `fr` / `de` / `ru` / `pt` 六份 `locale/<code>.json`：`meta` 只翻描述、标题保留品牌名，`ui` 的 125 个键与 `en` 一一对应，占位符不变。
- **复数选择 (a)：改写成语数无关的句子**。带数字的 `board.fold.expand` / `session.fold.expand` 不再写成「Noch {count} Karten」这类数词直接修饰名词的句子；数字只放在括号里，名词用不随数变化的类别复数（de / fr / es / pt / ru）。没有引入 `one` / `other` 分支：ru 还要 `few` / `many` 等档，`t()` 与生成器都要扩，维护成本高于收益。
- **没有项目名时不再套「某项目名 + 介词」**：`board.notProject.hint` 只接收真实项目名；`project.name` 缺失时走新键 `board.notProject.unknown` 的自包含句子，避免 ru / de 的格变错。`board.thisProject` 因此删除。
- **ja 术语统一为「ボード」**：tab、看板说明、无项目提示都用「ボード」，`meta.description` 用「プロジェクトのボード」，不再混用「デリバリーボード / プロジェクトボード」。
- 生成物 `src/client/locales.generated.js` 由 `build/locales.mjs` 重新生成；客户端注册代码本来按文件枚举，不需要改动。
- 术语跟宿主 common 字典对齐（Copy / Copied、Cancel、Close、Delete、Save、Footnotes 等直接复用宿主译法；es 的 Footnotes 已改为宿主的「Notas a pie de página」）；插件概念在每种语言内各保持一种译法，board 统一为 ボード / tablero / tableau / Board / доска / quadro。
- `tests/locales.test.js` 从「中英对照」改成遍历宿主 8 种语言，并新增「随包字典覆盖宿主注册的 8 种语言」；它还直接读 `locale/*.json`，校验源文件集合与生成字典一致，避免只有生成物过期时才红。`tests/slot-labels.test.js` 也遍历全部语言，防止新增语言漏掉内置槽位键。
- e2e 的 ja 断言从「回退英文」改成「逐字等于 ja 字典」：ja 现在有字典，CJK 判据不再适用（日文含汉字），四处标签逐字比对才能证明没有走回退。
- 回退链不变：未来宿主新增语言而本仓尚未提供字典时，仍按 active → fallback → `en` 显示。

## Alternatives considered

- **只补部分语言（如 ja / de）**：宿主语言菜单整体开放，漏掉的语种仍会整块显示英文；补齐 8 种才与宿主一致。
- **机器翻译直接上线、不校对术语**：插件文案里有状态、错误与不可逆操作说明，术语不一致会误导操作；六份字典按宿主 common 词汇人工对齐，再用键集/占位符门禁兜底。
- **构建期按宿主 catalog 动态生成语言列表**：宿主 catalog 是运行时的，构建期拿不到；把宿主列表写死成生成门禁会在宿主加语言时误报，现有设计仍是「本地文件 + 运行时告警」。
- **新增语言只加文件、不加测试**：现有门禁只比较已有语言，缺语言不会红；所以补一条「8 种语言都在」的单测和 ja 的真机切换断言。
- **把 `meta.title` 也本地化**：`Leader Agent` 是品牌名，宿主市场卡与安装后的插件名需要一致；只翻描述。

## Consequences

- 插件在宿主 8 种语言下都显示对应语言，不再整块回落到英文；语言切换仍由宿主的 `t` 与注册期 thunk 驱动，无需额外接线。
- 维护成本从 2 份字典变成 8 份：新增或修改任何 key 都要同步 8 份 `ui`，键集、占位符、空值与未使用 key 由 `verify-locales` 拦住；翻译质量仍需人工审查。
- 六种语言的术语以本仓使用习惯为准，不保证与宿主业务文案逐句一致；宿主下发的 `result.error.message` 仍是宿主语言，这是原有边界。
- `tests/locales.test.js` 固定了「随包 8 种」这一产品事实；宿主将来新增语言时这条不会自动变红，但运行时会告警，需手动补字典。
- 收益：插件界面与宿主语言菜单对齐，非中英用户不再看到半英半中的插件面板。

## Testing

- `tests/locales.test.js`：8 种语言键集/占位符/非空，覆盖集与宿主 8 种一致；直接读 `locale/*.json` 与生成字典比对。
- `tests/slot-labels.test.js`：每种语言都覆盖内置槽位键。
- `tests/e2e/i18n-switch.e2e.js`：真实宿主 zh → en → ja → zh，ja 四处标签逐字等于 ja 字典；`<html lang>` 与四处标签并进同一个等待条件，避免切换瞬间读到旧值。
- 双向验证：临时删 `locale/ja.json` 的一个 key（不重建），`tests/locales.test.js` 因源文件与生成字典不一致变红；重建后键集门禁与单测也红。还原后全绿。
- 复数三档手工渲染：六种语言各输出 `count = 0 / 1 / 2` 的 `board.fold.expand` 与 `session.fold.expand`，数字不再直接修饰名词；输出见 PR 证据。
