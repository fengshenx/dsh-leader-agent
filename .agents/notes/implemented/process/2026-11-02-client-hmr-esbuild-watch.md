# 客户端改动实时生效：esbuild watch + 宿主 client-hmr

## 背景

宿主 Web 组合默认挂 `@deepseek-ai/dsh-client-hmr`：node 侧 stat-poll 每个插件行的 client 产物，变化就 `clientModules.rebuilt(id)` → SSE → 浏览器拆旧 fiber 重新 `apply`；`link:` 包的 `clientPath` 解析到工作树里的 `lib/client.js`，本来就在 poll 范围内。整条链路缺的只有构建侧的常驻监听——此前改 `src/client/` 必须手动重建再手动刷新。

## 决策

- **只补构建侧**：`npm run dev` 先同步构建一次（失败当场退出，不带着坏产物起实例），再起常驻 watch；替换时机、失败呈现、级联重载都由宿主负责，本仓不做第二套机制。
- **不引 vite 或任何第二套模块图**：产物契约是 closure-factory（`window.__ModuleLoader__.load({ id, factory })`），React 与 react-dom 必须 external、由宿主模块表提供唯一实例；Vite dev 给的是自己的 ESM 图与 HMR runtime，prebundle 出来的 React 进产物就是第二份实例，hooks 直接失效。
- **构建核心抽成 `build/client-bundle.mjs`**：入口 `build/client.mjs` 只解析参数与定位路径，配置、基线清单与原子写在核心，单测能直接跑真实构建守住产物契约。
- **基线模块清单与宿主 `PLATFORM_MODULES` 对齐**：当前 react / react-dom / ui-primitives；本仓没装 ui-primitives，不 external 直接 `Could not resolve`，内联则出现第二份实现。
- **产物写入 staging + rename，staging 按进程隔离**：宿主 poll 只比 stat，读到半截文件会替换失败且没有回滚；先写 `<产物>.<pid>.<随机>.staging` 再 rename，构建失败时正式产物保持上一份。固定 staging 名会被并发构建抢走，竞争只剩「后完成 rename 的赢」。
- **watch 与 dsh 都用 `spawn` 子进程**：`spawnSync` 阻塞事件循环，SIGINT/SIGTERM 处理器跑不到，watcher 会成孤儿；父进程持两个句柄，正常退出、构建失败、SIGTERM、SIGINT 走同一套清场。
- **首建失败不冒充「watch 已建立」**：`ctx.watch()` resolve 时首次构建可能还没结束；等首次构建结果，失败就打印「watch 已建立，但首次构建失败」，正式产物保持上一份。

## 边界

- 宿主不做 react-refresh 级状态保留：替换 = 拆 fiber 重新 `apply`，插件内 React 状态重置；无失败回滚，本仓只能保证不主动喂半截文件。
- 只覆盖 Web 的 SSE 通道；Electron 安装形态与后端重启不走这条。`npm start` 不挂 watch。
- watcher 看的是入口的依赖图；改 `package.json` 依赖仍要回主 checkout 安装。
- 没有 `DEV_NO_WATCH`；并发构建只保证不共写、不撕裂，不保证产物对应最新源码。
- `rmSync(staging)` 是防御性死代码（当前 esbuild 失败时不写 staging）；`initialBuildFailed` 只报首建；信号退出用 `exit(130/143)`，不等子进程真正退出。

## 验证

`tests/client-build.test.js` 钉住产物外壳、external 清单、原子写与失败保留；双向读数：清空 `BASELINE_EXTERNALS` → 三个构建用例红（`Could not resolve`），staging 改回固定名 → 10 个并发构建 4 个 `ENOENT`。
