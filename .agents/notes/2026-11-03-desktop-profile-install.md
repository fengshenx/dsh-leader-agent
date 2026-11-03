# 桌面版挂载：npm run desktop 直接改 desktop profile

**状态**：implemented（2026-11-03）
**范围**：`scripts/{desktop,desktop-plan}.mjs`、`package.json`、`README{,_ZH}.md`、`docs/development.md`、`AGENTS.md`、`tests/desktop-plan.test.js`

## 背景

用户问两件事：本插件能不能在 DeepSeek Harness 桌面版里用，以及能不能用 `npm run xxx` 启动。实测与宿主源码给出的边界是：

- 桌面版是 Electron 壳 + 完整 Web 应用，profile 固定为 `$DSH_HOME/profiles/desktop`（`apps/desktop/src/paths.ts`），与 CLI 的 `profiles/web` 各自一套包、激活状态与 lockfile。装进 `web` 的插件桌面版看不到。
- `dsh --profile desktop` 被宿主直接拒绝：`profile "desktop" is managed exclusively by the Electron application`。
- 桌面 App 的插件管理支持本地绝对路径，是正规入口；但开发期要在工作树里改代码即生效，靠对话框每次手填路径不够。
- `npm run dev` / `npm start` 都只启动 `dsh web`，不会拉起桌面应用。

## 决策

### 脚本直接改 manifest 与链接，不跑 pnpm

`npm run desktop` 往 desktop profile 的 `package.json` 写 `dsh-leader-kit: link:<当前目录>`、把包名追加进 `dsh.profile.bundles`，并在 `node_modules` 里建符号链接（`junction`，Windows 不需要管理员）。

- 桌面应用执行包操作时用的是它自带的 pnpm 与 Electron Node 模式（`ELECTRON_RUN_AS_NODE`、私有 launcher 环境）。脚本复刻那套环境容易随宿主版本漂移而失效；而宿主启动时只按 `bundles` 列表解析包，不校验 `link:` 与磁盘链接是否一致——`npm run dev` 的派生 profile 已经用同一机制跑通。
- 代价是 `pnpm-lock.yaml` 与 manifest 短暂不一致；link 依赖不需要网络，下次在桌面应用的插件管理里做安装/卸载时由 pnpm 自己补齐。这个代价写进 README 的一句话里。

### 别人的安装不覆盖，运行中不写入

- 依赖条目已有本插件但说明符不是当前目录时直接报错：那可能是插件管理装的版本，或另一个工作树挂上去的，覆盖要由人决定。
- `node_modules/dsh-leader-kit` 已存在时只接受两种状态：不是符号链接（插件管理装的实体目录）拒绝；符号链接但指向别的工作树也拒绝。后一种是审查阶段补的——原实现对「指向别处」直接 `rm` 再重建，等于把别人的安装悄无声息顶掉，与上面那条 manifest 守卫的语义不一致。判定收敛成纯函数 `planLinkAction`（`create` / `keep` / `refuse`），IO 只执行结论。
- **先建链接、再写 manifest**：链接被别人的安装挡住时立刻失败，manifest 保持原样。反过来会留下「bundles 里声明了 `dsh-leader-kit`、`node_modules` 却是插件管理的实体目录」的坏状态（实测确认：拒绝时 manifest 已被改写）。链接成功而写 manifest 失败，只留一个没人引用的链接，下次重跑按 `kept` 处理，宿主也不会加载它。
- 桌面应用运行中拒绝写入：宿主只在启动时读 profile，写入不生效，还可能和应用自己的插件管理撞上。macOS / Linux 用 `pgrep -x <进程名>` 探活；Windows 不探，脚本在启动那一步明确提示手动打开。
- `DSH_DESKTOP_APP` 允许写成 `.app` 路径（`open -a` 两种都收），但 `pgrep -x` 只认进程名：原实现把整条路径喂给 `pgrep`，运行中的应用必然漏判。探活前先经 `pgrepNameOf` 归一化（取 basename、去 `.app`）。实测 `pgrep -x Finder` 命中、`pgrep -x /System/Library/CoreServices/Finder.app` 不命中。
- `--remove` 只摘本插件的依赖条目、bundle 项与链接，其余条目与顺序原样保留。

### 文档归属

README 的安装章节加「桌面版」小节给使用者操作（一条命令 + 撤销 + 两条限制）；机制细节在 `docs/development.md` 的一句话与本文，不重复展开。`AGENTS.md` 只在常用命令表加一行。

三份文档的天花板按合并后的当前值重算，不沿用分支上的旧数（main 期间被 #77 / #79 / #81 改过多轮）：`AGENTS.md` 3930 → 4000、`README.md` 3250 → 3400、`README_ZH.md` 4850 → 5100、`docs/development.md` 1780 → 1900。同时把合并后已低于阈值的 `docs/capability-gaps.md`（15500 → 16800，按 ≥10%）、`docs/e2e-testing.md`（4340 → 4400）一并拉回——那两项不是本 PR 压下去的，但同一条规则，留着会让下一次改动无余量。桌面版的安装入口只能放在 README 的 Quick Start 里——它是使用者会先看的那一层，塞进 docs 等于没写；development 那条同理，属于「实例怎么起」的归属层，不重复搬到别处。

## 边界

- 同一时刻只能挂一个工作树版本：desktop profile 只有一份，已挂别的工作树时会被拒绝，要换先 `--remove`。多工作树并行验证仍用 `npm run dev`。
- macOS 的进程名在 `p_comm` 里截断到 16 字符，应用名超过 16 字符时 `pgrep -x` 仍可能漏判（默认名「DeepSeek Harness」正好 16）。没改用 `pgrep -f`：它匹配整条命令行，编辑器开着同名路径就会误判，宁可漏判时靠人按 ⌘Q。
- 不支持用 `DSH_HOME` 起一个隔离的桌面实例：App 固定读该变量下的 `profiles/desktop`，而 Desktop 的更新、账号与窗口状态在 Electron userData 下，与 profile 数据根不是一回事。隔离验证继续走 web 形态的开发实例。
- Windows 上不探进程、不自动拉起应用，脚本只完成 profile 写入并提示手动启动。
- 桌面版的插件包与激活状态和 CLI 分开，但会话、项目、卡片数据在同一个 `$DSH_HOME` 下共享。

## 验证

- `tests/desktop-plan.test.js` 12 个用例：路径解析（默认与 `DSH_HOME` 覆盖、空串回落）、首次挂载写入依赖与 bundle 末尾、幂等、已装另一来源拒绝（工作树与版本号两种）、bundle 已含时不重复、缺 bundles 列表拒绝、摘除只动本插件、未装时摘除是空操作；审查阶段补三个：`pgrepNameOf` 的名字 / `.app` 名 / 路径 / 尾斜杠 / 空值、`planLinkAction` 的四种组合、`ensureLink` 先于 `writeManifest` 的源码顺序断言。
- 双向验证（逐条撤销 → 变红 → 还原，每次还原 12 pass）：
  - `planLinkAction` 的「指向别处」从 `refuse` 改回 `create`（即原来的静默替换）→ 1 fail（11 pass）。
  - `pgrepNameOf` 改成原样返回（不归一化）→ 1 fail（11 pass）。
  - `desktop.mjs` 里把 `writeManifest` 挪回 `ensureLink` 之前 → 顺序用例 1 fail（11 pass）。
- 临时数据根端到端（`DSH_HOME=/tmp/dsh-desktop-probe`，`DSH_DESKTOP_APP=__no_such_app__` 避免真的拉起应用；全程不碰本机 `~/.dsh/profiles/desktop`）：
  - 首次挂载：manifest 写入 `dsh-leader-kit: link:<当前工作树>` 与 bundles 末尾、`node_modules` 建出符号链接；再跑一次报「manifest 已是最新 / 链接 已指向当前目录」。
  - 预置「manifest 无记录、链接指向 `/tmp/other-worktree`」：修复后报「已经指向另一份安装（/tmp/other-worktree）」并退出，manifest 命中数 0、链接仍指向原处；修复前同一场景会静默改指当前工作树。
  - 预置「manifest 无记录、`node_modules/dsh-leader-kit` 是实体目录」：修复后拒绝且 manifest 命中数 0；修复前拒绝时 manifest 已被改写（命中 2 处 = dependencies + bundles）。
  - `--remove`：依赖条目与 bundle 项摘掉、其余依赖与顺序不变、链接删除；再跑一次报「manifest 本来就没有 / 链接 本来就没有」。
- 探活实证（macOS 只读）：`pgrep -x Finder` 命中、`pgrep -x /System/Library/CoreServices/Finder.app` 不命中；把后者当 `DSH_DESKTOP_APP` 跑脚本，修复后按「正在运行」拒绝且不写 profile，修复前会继续往下写。
- 实机（macOS，桌面版 0.2.1-rc.5）：`npm run desktop` 写入 `~/.dsh/profiles/desktop/package.json`（依赖 `link:/…/.worktrees/desktop-launcher`、bundles 末尾 `dsh-leader-kit`）并建链接；应用正常启动，Host 进程以 `profiles/desktop` 为参数加载，无致命错误。
- 应用运行中重跑 `npm run desktop` 被拒绝（`DeepSeek Harness 正在运行，profile 只在启动时读入`），profile 未被改动。
- `dsh --profile desktop --help` 返回 `profile "desktop" is managed exclusively by the Electron application`，确认无法用 CLI 形态替代验证。
- 摘除与冲突在临时数据根上验证，不打扰运行中的实例：`--remove` 后 manifest 回到挂载前（只剩 `dsh-session-file-reveal`，bundles 顺序不变）、链接删除；把依赖改成别的工作树后 `npm run desktop` 报「已经装了一份 dsh-leader-kit（link:/tmp/other-checkout）」并退出，manifest 未被改写。
