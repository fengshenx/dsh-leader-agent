# 协议层 skill 搬进 `.agents/skills/`：只留一份来源，别家 harness 也能发现

2026-11-02。

## 背景

协议层 skill 原先放在包根 `skills/`。这条路只有 dsh 认：`src/host/skills.js` 注册一个 bundle provider，从 `bundleRoot/skills` 读盘后交给 `ctx.skills`。本仓的定位是给别的项目用的 skill 基础框架，其他 harness 读的是项目级 `.agents/skills/`，看不到 `skills/`。

考虑过三种排布：在 `.agents/skills/` 放软链、搬过去、或者两份并存。

## 决策

### 搬成唯一位置，不软链

`git mv skills .agents/skills`，`src/host/index.js` 的 `skillsRoot` 改成 `join(bundleRoot, '.agents', 'skills')`。

软链在两个方向上都是实锤缺陷，不是理论风险：

- **npm pack 不展开目录软链**。实测：临时包同时列 `files: ["skills/**", ".agents/skills/**"]`，`.agents/skills` 软链到 `../skills`，打包结果只有 `skills/demo/SKILL.md`，`.agents/skills` 下一个文件都没进 tarball。软链方案下真实目录必须留着，等于继续维护两个路径概念。
- **git 存软链是 mode 120000**。Windows 上 `core.symlinks=false` clone 出来是普通文本文件；dsh 的目录扫描看到 file 而非 directory 直接跳过，没有任何报错——与本仓 Fail Loud 的取向相反。

`.agents/skills` 在 `files` 里显式列出即可打包，实测 `npm pack --dry-run` 含全部 9 个 skill 文件。dot 前缀目录不在 npm 默认忽略列表里。

### 宿主下限版本就认这个路径

本机 dsh 是 `0.2.1-rc.2`，正好是 `engines.dsh` 下限。它的 `dsh-skill-filesystem` 里 `.agents/skills` 与 `.dsh/skills` 并列为项目级 root，rank 分别是 200 与 100；bundle provider 自报 600。数值小者优先，所以同层合并后项目副本胜出，本仓作为项目打开时也不会出现两份同名 skill。

宿主对软链是跟随的（`nodeEntryKind` 对 symlink 做 `stat`）。所以搬迁不是因为"dsh 不认软链"，而是因为打包与跨平台 clone 这两处。

### 不做第二份特化副本

本仓作为项目需要的特化已经有专属载体：`AGENTS.md` 是读代码的模型看的工程规则，`COORDINATOR.md` 按身份注入协调者会话，`SLOTS.md` 按卡片绑定注入槽位。协议层 skill 的受众是任何装了 bundle 的项目，正文里的 `worktree`、`SLOTS.md`、`COORDINATOR.md` 都写成了"按项目约定"的抽象表述，没有本仓的 `.worktrees/<任务名>`、`npm run check`、Agent Note 格式。

真正需要特化的场景发生在用户自己的项目里：把改动副本放进那个项目的 `.agents/skills/`，rank 200 对 600 天然覆盖。在源仓复制一份只会制造双份漂移，而文档工具名门禁只扫一处路径，另一处漏改不会被抓。

### `files` 与 `skillsRoot` 由用例绑定

`package.json` 的 `files` 与 `src/host/index.js` 的 `SKILLS_DIR` 原本互不相干：任一侧漂移，`src/host/skills.js` 的读盘失败只会返回空候选，装机后协议层 skill 全部消失且无任何报错——目录藏进点前缀让肉眼更难发现。

`tests/skills.test.js` 现在读 `SKILLS_DIR`（目录名只此一处，装配与用例共用），递归列出该目录下的真实文件，按 npm `files` 的匹配语义（`**` 跨目录、`*` 只在段内、整段目录名递归收录、`!` 排除）断言每个文件都被覆盖。它守的是「`files` 支撑 `skillsRoot`」，而不是「源码树里有一个目录」——后者由装配层用例管。

同一处读盘失败补一条 warn：`skills.js` 不能抛错（会连累整个 skill catalog，其他 provider 也拿不到结果），但缺件需要信号，所以 `apply` 注入 `logger`，吞的时候把路径与原因打出来。

## 边界

- 本仓自己作为项目打开时，项目级 root 与 bundle root 指向同一目录，没法再用"项目副本"临时覆盖某个 skill 做调试。要验证改动就在 worktree 里改文件。
- 包内是隐藏目录：`package.json` 的 `files` 必须显式写 `.agents/skills/**`，漏了发布包就缺 skill。`tests/skills.test.js` 的覆盖断言会红，但那只管 `files` 与 `SKILLS_DIR` 的对齐；tarball 本身仍靠发版前跑 `npm pack --dry-run`。
- 这是路径搬迁，不改 skill 正文与发现逻辑：`src/host/skills.js` 的读取、rank、候选结构都不变。
- 已发布版本没有兼容垫片：本仓未发布，旧路径不做读取退回。

## 验证

- `npm run check`：642 tests / 642 pass / 0 fail（本次新增 2 条），Agent Note 门禁、文档工具名门禁与语法检查全过。
- `npm pack --dry-run`：tarball 含 `.agents/skills/` 下全部 9 个文件（2 个 `SKILL.md`、4 个 playbook、3 份参考），共 77 个文件。
- 新增用例「装配层：skill provider 读包内 `.agents/skills`」：在 `tests/coordinator-wiring.test.js` 的假 host 里捕获 `registerProvider` 的工厂，调 `list()` 断言发现 `init-project` 与 `leader-mode`。原 `tests/skills.test.js` 自己拼 `skillsRoot`，`index.js` 漏改不会红——这条补的是装配层的真实路径。
- 双向验证：把 `src/host/index.js:99` 临时改回 `join(bundleRoot, 'skills')` → 新用例红（provider 读盘失败静默返回空候选）；还原 → 2 / 2 绿。
- 新增用例「package.json 的 files 覆盖宿主读取的 skillsRoot」：三种漂移各自变红，还原后 6 / 6 绿——`files` 改回旧路径 `skills/**`（1 条红）、删掉该条（1 条红）、收窄成 `.agents/skills/*`（1 条红，嵌套文件漏 pack）；`SKILLS_DIR` 改成 `.agents/skill` 则 4 条红。
- 新增用例「skillsRoot 不可读时返回空候选并告警」：logger 收到 1 条含缺目录路径的告警，候选为空。
