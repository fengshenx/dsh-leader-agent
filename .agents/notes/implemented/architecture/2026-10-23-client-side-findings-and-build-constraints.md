# 客户端半边的发现与构建约束

**范围**：`cordis.patch.yml`、`index.js`、`src/client/`、`build/client.mjs`、`package.json`

## 背景

dsh 的 bundle 有两半：host 半边跑在 Node 进程，client 半边跑在浏览器进程。宿主按 `package.json` 的 `dsh.client` 声明发现 client 半边，把产物随 boot manifest 下发给浏览器；浏览器端再执行它注册的 Tab、slot body 等 UI 扩展。

本 bundle 要在右栏挂一个「看板」Tab，因此第一次真正接触 client 半边。踩到的两个约束都不是文档写明的，是从 dsh 源码与实测里挖出来的。

## 决策

**插件行名必须是纯包名**。`packages/client/modules/src/index.ts:892` 的 `locatePkgJson` 靠 Loader 行名定位包 manifest 才能判断「这个包有 client 半边」：`exactPackageSpecifier` 不接受含 `/` 的子路径。行名写成 `dsh-leader-agent/src/host` 时定位失败，该行不会被识别为 client row——宿主根本不下发 client bundle，浏览器右栏只剩内置欢迎页。改成 `dsh-leader-agent` 后，包入口相应改为再导出 host 侧实现（`index.js` 的 `apply`/`inject`/`name` 全部来自 `src/host/index.js`，不再自己声明一份 `name`，避免重复导出）。

**client 产物自己产，用 esbuild 复刻 closure-factory 封装**。dsh 的 `clientBundle` 预设（`packages/client/tsdown.client.ts`）绑定仓内 `PLATFORM_MODULES` 等多个模块，第三方仓无法引用；宿主按 closure-factory 约定加载产物（`window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports; } })`）。于是 `build/client.mjs` 用 esbuild 产出 CJS 产物：banner 注册工厂并注入 require，footer 交回 exports；产物里留下的外部 import 由工厂的 require 解析。产物不入库（`.gitignore` 忽略 `lib/`），发布时由 `prepublishOnly` 重建。

**React 不进本仓依赖，也不进产物，但必须留在产物外面**。宿主 web 端自带 React：`packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES` 列了 react、react-dom 等基线模块，`seed.ts` 把它们静态 import 进冻结模块表，注释写明「every bundle sees the same instance」。因此本仓既不装 React 依赖（会打出第二份 React 实例，hooks 随之失效），也不能让 esbuild 把它打进产物——`build/client.mjs` 的 `BASELINE_EXTERNALS` 固定 external 掉 react 与 react-dom，产物里只留 `require("react")` 与 `require("react-dom")`，运行时由宿主模块表提供同一份实例。

**manifest 的 `dsh.client.external` 不声明 React**。宿主契约里 `external` 是「基线之外的额外模块请求」（`package-manifest/src/types.ts`：「beyond the implicit client baseline」；`client/modules` 的 `WebBootEntry.external`：「Non-baseline module specifiers this row requests」），基线模块本来就能解析，重复声明反而是违规——宿主自己的 CI 脚本 `scripts/verify-client-packages.ts` 会把「重复基线模块」的声明判成 violation 并自动移除。本仓产物只 require 基线里的 react 与 react-dom，不需要任何额外请求，于是整个 `external` 字段留空（缺省即只要基线）。

**构建期的 external 与 manifest 的 external 是两件事**。前者决定哪些 import 留在产物外（必须含 react），后者是给宿主的模块请求清单（只含非基线模块）。二者一度共用同一份清单——`build/client.mjs` 直接读 `package.json` 的 `dsh.client.external` 当 esbuild 的 external——于是删掉冗余声明会把 React 打进产物。已拆开：构建期由 `BASELINE_EXTERNALS` 自持，manifest 侧不再声明。

**基线复核锚点**（按宿主 tag 对照）：`PLATFORM_MODULES` 在 `packages/client/web/src/platform.ts`；`seed.ts:9-19` 把 rc.2 的四个宿主自有包（`dsh-client-store` / `dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-ui-dockkit`）静态 import 进 `:26` 的 `getStaticModules`，这些 `src/` 文件不在 npm 安装包里（`files` 只发 `lib/`）。基线之外的宿主 UI 包可由另一个插件行 supplier 的模块引入，判定见 `scripts/verify-client-packages.ts:352-381`。本包 manifest 的 `dsh.client.platform` 是 `web`，ACP / headless / SDK 组合不加载客户端半边。

**面板订阅会话事件窗口，不另存一份卡片**。纯 session projection 路线走不通——仓外事件类型不进宿主读路径（见 capability-gaps 第 8 条）。可行的取法是 `ctx.sessions.retain(sessionId, { source })` → `reference.ready` → `reference.binding.eventSource`（`ObservableSnapshot<SessionEventWindow>`），筛出 `tool/result` 事件取其 `meta` 投影重放。全量投影清空视图，单卡投影覆盖一张卡。

**Tab 类型 id 兼作面板注册键**。`SidebarRightTabDefinition.id` 是实现身份，也是它在 `sidebar.right.pane.tab` 座里的注册键；`kind` 只用来区分「这类 Tab 是什么」，`openTab` 按 kind 寻址。

**面板主动加载完整历史，不只读当前窗口**。会话事件窗口初始只装最近一页（`hasMore` 标志更早历史未加载）。只重放窗口内的投影，长会话下早期的卡片不显示；更隐蔽的是窗口内若恰有 `list_cards` 的全量投影，它本应是完整列表，却被当成窗口内的部分视图看待，破坏「全量投影是权威快照」的前提。因此面板驱动 `SessionFace.loadOlder()` 逐页加载到没有更早历史再重放。`loadOlder` 失败时宿主只记日志不抛错，故翻页设上限（20 页），到顶则标注「仅显示已加载的历史片段」，空态文案也据此区分「没有卡片」与「历史未加载完」。

**面板用 `React.createElement` 写，不引 JSX**。少一层构建配置，且产物是单文件 closure-factory，JSX 转换的运行时开销没有必要。

**并行开发的 worktree 建在仓内 `.worktrees/`**。主 checkout 保持干净，改动全部落在 worktree 里；多个任务并行时各占一个目录（`git worktree add .worktrees/<任务名> -b feature/<任务名>`）。目录名用复数 `.worktrees/`——单数 `.worktree/` 容易被当成单个任务的目录。该目录已进 `.gitignore`：否则 worktree 里的文件会被主 checkout 当成仓内未跟踪文件，`git status` 一直脏。

## 边界

- **看板只覆盖当前会话**。卡片随会话事件持久化，面板重放本会话的投影——别的会话建的卡不会出现在这里。这是「卡片与 session log 一起存」的必然结果，不是缺陷。
- **信号灯与槽位绑定未做**。停滞判定是纯投影，等看板交互定型后再补；槽位绑定规则待 P3 与角色槽位一并定。
- **翻页有上限**。历史超过 20 页时看板只显示已加载部分，并在面板顶部标注——此时「全量投影」的权威性仍然只覆盖已加载窗口。
- **注册必须放进 `ctx.effect`**。注册表把 effect 挂到调用方 fiber 上，在别的插件的 apply 里直接注册会让浏览器启动静默卡住。
- **`ctx.sessions` 在 apply 期可能未就绪**，因此注入面板的是延迟取值器 `() => ctx.sessions`，不是当时的快照。
- **worktree 不要再往里套 worktree**。`.worktrees/` 在仓内，worktree 里再 `git worktree add .worktrees/<x>` 会递归嵌套，git 会拒绝或产生怪路径。新任务一律从主 checkout 建。
- **profile 的 link 指向 worktree 目录**。开发时 `~/.dsh/profiles/<name>/package.json` 把 `dsh-leader-agent` link 到 worktree 路径（`link:/…/dsh-leader-agent/.worktrees/<任务名>`）；worktree 删掉后 profile 就断了，要改回主 checkout 的路径。

## 证据

web profile（dsh 0.2.1-rc.2）实测：boot manifest 从 70 条目变 71 条目，多出的条目即本包（`plugins/??dsh-leader-agent/client.js`，`inject` 含 `@deepseek-ai/dsh-client-ui-sidebar-right` 与 `@deepseek-ai/dsh-api-session-controller`）；浏览器右栏出现「看板」Tab，点开显示面板。

删掉 manifest 的 `dsh.client.external` 后实测：插件照常被发现与加载，产物里仍只有 `require("react")` 与 `require("react-dom")` 两处外部依赖，看板渲染 4 张卡（3 张 active + 1 张已完成），信号灯四档与链接 chip 均正常，控制台无报错。

数据通道实测：web 会话里模型调 `create_card` → 落盘 `#3「端到端验证卡片」` → 该会话的 `tool/result` 事件 `meta` 携带 `{"kind":"dsh-leader-agent-cards","scope":"card","cards":[…]}`。

行名改动后的 host 侧回归：sdk profile + mock LLM 实测 `create_card` 仍工作（落盘 `#2「行名回归验证卡片」`），49 例单测全绿。
