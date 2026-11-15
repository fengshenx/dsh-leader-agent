# 协议层 skill 搬进 `.agents/skills/`：只留一份来源，别家 harness 也能发现

## 背景

协议层 skill 原先放在包根 `skills/`，只有 dsh 认（bundle provider 从 `bundleRoot/skills` 读盘）。本仓定位是给别的项目用的 skill 基础框架，其他 harness 读的是项目级 `.agents/skills/`，看不到 `skills/`。软链、搬过去、两份并存三种排布都评估过。

## 决策

- **搬成唯一位置，不软链**：npm pack 不展开目录软链（实测 tarball 里一个文件都没进），git 存软链是 mode 120000，Windows 上 `core.symlinks=false` clone 成普通文件、目录扫描直接跳过且不报错。`.` 前缀目录不在 npm 默认忽略列表，`files` 里显式写 `.agents/skills/**` 即可打包。
- **宿主下限版本就认这个路径**：`.agents/skills` 与 `.dsh/skills` 并列为项目级 root，rank 低于 bundle provider，同层合并后项目副本胜出；本仓作为项目打开时不会出现两份同名 skill。
- **不做第二份特化副本**：本仓需要的特化已有专属载体（`AGENTS.md` 工程规则、`COORDINATOR.md` 身份注入、`SLOTS.md` 槽位绑定）；协议层 skill 的受众是任何装了 bundle 的项目，正文写成「按项目约定」的抽象表述。用户在**自己项目**的 `.agents/skills/` 放改动副本即可覆盖（rank 天然更低），在源仓复制只会制造双份漂移，而文档工具名门禁只扫一处路径。
- **`files` 与 `skillsRoot` 由用例绑定**：两侧任一处漂移时读盘失败只返回空候选、装机后协议层 skill 全消失且无报错，所以用例读同一个 `SKILLS_DIR` 常量、递归列出真实文件，按 npm `files` 匹配语义断言逐个被覆盖——守的是「`files` 支撑 `skillsRoot`」而不是「源码树里有这个目录」。
- **读盘失败打 warn 而不抛**：`skills.js` 抛错会连累整个 skill catalog、其他 provider 也拿不到结果；缺件靠注入的 logger 打出路径与原因。

## 边界

- 本仓自己作为项目打开时，项目级 root 与 bundle root 指向同一目录，没法再用项目副本临时覆盖某个 skill 做调试；验证改动要在 worktree 里改文件。
- 包内是隐藏目录：漏写 `files` 时发布包缺 skill，用例会红但那只管对齐，tarball 本身仍靠发版前 `npm pack --dry-run`。
- 这是路径搬迁：不改 skill 正文、读取、rank 与候选结构。
- 已发布版本没有兼容垫片：本仓未发布，旧路径不做读取退回。

## 验证

装配层用例在假 host 里捕获 provider 工厂并断言发现包内 skill；`tests/skills.test.js` 按 `files` 语义守覆盖，三种漂移（旧路径、删条目、收窄通配）各自变红。
