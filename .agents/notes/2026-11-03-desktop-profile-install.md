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
- `node_modules/dsh-leader-kit` 已存在且不是符号链接时同样拒绝（像是插件管理装的实体目录）。
- 桌面应用运行中拒绝写入：宿主只在启动时读 profile，写入不生效，还可能和应用自己的插件管理撞上。macOS / Linux 用 `pgrep -x <应用名>` 探活；Windows 不探，脚本在启动那一步明确提示手动打开。
- `--remove` 只摘本插件的依赖条目、bundle 项与链接，其余条目与顺序原样保留。

### 文档归属

README 的安装章节加「桌面版」小节给使用者操作（一条命令 + 撤销 + 两条限制）；机制细节在 `docs/development.md` 的一句话与本文，不重复展开。`AGENTS.md` 只在常用命令表加一行。

三份文档的天花板按当前值重算：`README.md` 3250 → 3370、`README_ZH.md` 4850 → 5060、`docs/development.md` 1780 → 1850，均留 5% 余量。桌面版的安装入口只能放在 README 的 Quick Start 里——它是使用者会先看的那一层，塞进 docs 等于没写；development 那条同理，属于「实例怎么起」的归属层，不重复搬到别处。

## 边界

- 同一时刻只能挂一个工作树版本：desktop profile 只有一份，后跑 `npm run desktop` 的覆盖先前链接（先跑的会被拒绝，需先 `--remove`）。多工作树并行验证仍用 `npm run dev`。
- 不支持用 `DSH_HOME` 起一个隔离的桌面实例：App 固定读该变量下的 `profiles/desktop`，而 Desktop 的更新、账号与窗口状态在 Electron userData 下，与 profile 数据根不是一回事。隔离验证继续走 web 形态的开发实例。
- Windows 上不探进程、不自动拉起应用，脚本只完成 profile 写入并提示手动启动。
- 桌面版的插件包与激活状态和 CLI 分开，但会话、项目、卡片数据在同一个 `$DSH_HOME` 下共享。

## 验证

- 新增 `tests/desktop-plan.test.js` 9 个用例：路径解析（默认与 `DSH_HOME` 覆盖、空串回落）、首次挂载写入依赖与 bundle 末尾、幂等、已装另一来源拒绝（工作树与版本号两种）、bundle 已含时不重复、缺 bundles 列表拒绝、摘除只动本插件、未装时摘除是空操作。`node --test tests/desktop-plan.test.js` 全绿。
- 实机（macOS，桌面版 0.2.1-rc.5）：`npm run desktop` 写入 `~/.dsh/profiles/desktop/package.json`（依赖 `link:/…/.worktrees/desktop-launcher`、bundles 末尾 `dsh-leader-kit`）并建链接；应用正常启动，Host 进程以 `profiles/desktop` 为参数加载，无致命错误。
- 应用运行中重跑 `npm run desktop` 被拒绝（`DeepSeek Harness 正在运行，profile 只在启动时读入`），profile 未被改动。
- `dsh --profile desktop --help` 返回 `profile "desktop" is managed exclusively by the Electron application`，确认无法用 CLI 形态替代验证。
- 摘除与冲突在临时数据根（`DSH_HOME=/tmp/dsk-desktop-test`）上验证，不打扰运行中的实例：`--remove` 后 manifest 回到挂载前（只剩 `dsh-session-file-reveal`，bundles 顺序不变）、链接删除；把依赖改成别的工作树后 `npm run desktop` 报「已经装了一份 dsh-leader-kit（link:/tmp/other-checkout）」并退出，manifest 未被改写。
