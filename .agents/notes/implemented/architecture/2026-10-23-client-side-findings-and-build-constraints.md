# 客户端半边的发现与构建约束

## 背景

dsh bundle 有 host 与 client 两半：宿主按 `package.json` 的 `dsh.client` 发现 client 半边，把产物随 boot manifest 下发浏览器。本 bundle 要在右栏挂一个「看板」Tab，第一次真正接触 client 半边，踩到的约束都不是文档写明的。

## 决策

**插件行名必须是纯包名**：宿主靠 Loader 行名定位包 manifest 才能判断「这个包有 client 半边」，含 `/` 的子路径不接受；行名写成 `dsh-leader-agent/src/host` 时宿主根本不下发 client bundle。包入口相应改为再导出 host 实现，不再自己声明一份 `name`。

**client 产物自己产，用 esbuild 复刻 closure-factory 封装**：宿主按 `window.__ModuleLoader__.load({id, factory})` 约定加载产物，而官方预设绑定仓内 `PLATFORM_MODULES` 等模块，第三方仓引用不到。产物里留下的外部 import 由工厂的 require 解析；产物不入库，发布时由 `prepublishOnly` 重建。

**React 不进本仓依赖、也不进产物，但必须留在产物外面**：宿主 web 端自带 React，模块表注释写明「every bundle sees the same instance」；装依赖或打进产物都会出现第二份实例，hooks 随之失效。

**manifest 的 `dsh.client.external` 不声明 React**：`external` 是「基线之外的额外请求」，重复声明基线模块按宿主规则判违规；产物只 require 基线模块，整个字段留空。

**构建期 external 与 manifest external 是两件事**：前者决定哪些 import 留在产物外（必须含 React），后者是给宿主的模块请求清单（只含非基线模块）。二者一度共用同一份清单，于是删掉冗余声明会把 React 打进产物；现在构建期清单由 `BASELINE_EXTERNALS` 自持。

**基线模块由宿主冻结模块表提供，基线外的宿主 UI 包不保证可用**（需另一个插件行 supplier）；本包 manifest 的 `dsh.client.platform` 是 `web`，ACP / headless / SDK 组合不加载客户端半边。

> **看板取数已换**：P5 起看板走宿主侧项目通道读卡片库（见 [看板按项目组织](../feature/2026-10-27-project-bound-board.md)），不再从当前会话的事件窗口重放卡片投影；`presentationMeta` 仍用于会话历史里的卡片投影。

**Tab 类型 id 兼作面板注册键**：`SidebarRightTabDefinition.id` 是实现身份，也是它在 `sidebar.right.pane.tab` 座里的注册键；`kind` 只区分「这类 Tab 是什么」，`openTab` 按 kind 寻址。

**面板用 `React.createElement` 写，不引 JSX**：产物是单文件 closure-factory，没必要再加一层 JSX 转换。

**并行开发的 worktree 建在仓内 `.worktrees/`**（复数，单数容易被当成单任务目录）：主 checkout 保持干净，改动全部落 worktree；该目录已进 `.gitignore`，否则 worktree 里的文件会被当成仓内未跟踪文件。

## 边界

- **看板读宿主卡片库**：卡片按项目聚合，别的会话建的卡也会出现在项目看板上；`presentationMeta` 仍是会话历史里的卡片投影通道，其形状变化只影响会话历史。
- **注册必须放进 `ctx.effect`**：注册表把 effect 挂到调用方 fiber 上，在别的插件 `apply` 里直接注册会让浏览器启动静默卡住。
- **`ctx.sessions` 在 apply 期可能未就绪**，注入面板的是延迟取值器，不是当时的快照。
- **worktree 不要再往里套 worktree**：新任务一律从主 checkout 建。
- **profile 的 link 指向 worktree 目录**：worktree 删掉后 profile 就断了，要改回主 checkout 的路径。

## 验证

`tests/client-build.test.js` 钉住产物形态与 external 拆分。双向读数：删掉 manifest 的 `dsh.client.external` 后产物仍只有基线 require、插件照常下发；把构建期与 manifest 的清单合回一份，产物里出现 React 实现即失败。
