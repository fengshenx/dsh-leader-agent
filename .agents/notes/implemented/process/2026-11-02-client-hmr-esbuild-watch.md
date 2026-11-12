# 客户端改动实时生效：esbuild watch + 宿主 client-hmr

## 背景

宿主 Web 组合默认挂着 `@deepseek-ai/dsh-client-hmr`（`dsh-v0.2.2-rc.2` 的 web-app bundle（`dsh-web-app/cordis.patch.yml:222`）已有该行）：node 侧每 500ms stat-poll graph 里每个插件行的 client 产物，`mtime/ctime/size` 任一变化就 `clientModules.rebuilt(id)` → SSE `/plugins/events` → 浏览器 `entries.reload(id, rev)` 拆旧 fiber 重新 `apply`。第三方 `link:` 包的 `clientPath` 解析到工作树里的 `lib/client.js`，本来就在 poll 范围内。

本仓此前只在 `npm run dev` 里同步构建一次，改 `src/client/` 必须手动重建再手动刷新页面。整条链路里唯一缺的就是构建侧的常驻监听。起步时基于 `f531c62`；`main` 上 #52 把 `MarkdownText` 引进来后，外部模块清单必须跟着扩到 `ui-primitives`，否则 rebase 后构建直接失败。

## 决策

### 只补构建侧，渲染与宿主通道一律复用

`npm run dev` 先同步构建一次（失败当场退出，不带着坏产物起实例），再起常驻 watch。浏览器侧一行不改：替换时机、失败呈现、级联重载都由宿主负责，本仓不做第二套机制。

### 不引 vite 或任何第二套模块图

产物契约是 closure-factory：首行注册 `window.__ModuleLoader__.load({ id, factory })`，React 与 react-dom 必须 external、由宿主模块表提供唯一实例。Vite dev 给的是自己的 ESM 图与 HMR runtime，还要往宿主页面注入客户端脚本（页面不归本仓控制）；prebundle 出来的 React 一旦进产物就是第二份实例，hooks 直接失效。

### 构建核心抽成 `build/client-bundle.mjs`

入口 `build/client.mjs` 只解析参数、定位路径；配置、基线模块清单与原子写在 `client-bundle.mjs`，单测可直接跑真实构建守住产物契约（外壳、external、原子写）。`AGENTS.md`、`tests/markdown.test.js` 与文档里「基线模块由构建期 `BASELINE_EXTERNALS` 留在产物外」的路径都指向这个文件。

### 基线模块清单与 #52 对齐

`src/client/markdown.js` 从 `@deepseek-ai/dsh-client-ui-primitives` 导入 `MarkdownText`，经 `worker-report-view.js` / `card-detail.js` 进入口图。该包是宿主 rc.2 `PLATFORM_MODULES` 的基线模块，必须 external：本仓 `node_modules` 没装它，不 external 会直接 `Could not resolve`；装进依赖再内联则出现第二份实现，违反「基线模块同一实例」。清单与出处注释照 `main` 的 `build/client.mjs` 迁入 `client-bundle.mjs`，当前为 react / react-dom / ui-primitives 三项。

### 产物写入走 staging + rename，staging 按进程隔离

宿主 poll 只比 stat，读到半截文件会替换失败且**没有回滚**（旧 fiber 已拆）。esbuild 先写 `<产物>.<pid>.<随机>.staging`，成功后 rename 到正式路径，宿主看到的永远是完整产物；构建失败时正式产物保持上一份。

staging 原先固定为 `<产物>.staging`，同树里 watcher 与手动 `npm run build:client` 并存时会共写同一路径：先完成的 rename 把另一个进程正在写的文件搬走，实测 10 个并发构建 3-4 个 `ENOENT`，理论上还可能把半截文件 rename 成正式产物。加 pid + 随机后缀后各写各的，竞争只剩「后完成 rename 的赢」——不保证内容新旧顺序，但不会撕裂。

### watch 用独立子进程，信号路径也要清场

`spawnSync` 阻塞主进程，watch 必须是 `spawn` 出来的子进程。dsh 本身也改成 `spawn`：`spawnSync` 等待期间事件循环被占住，注册的 SIGINT/SIGTERM 处理器根本跑不到，父进程收到 SIGTERM 会一直挂到 dsh 自己退出，watcher 成了孤儿。现在父进程持有两个子进程句柄，正常退出、构建失败、SIGTERM、SIGINT 都走同一套清场。Ctrl-C 会把 SIGINT 发给整个前台进程组，watcher 与 dsh 本来也会收到，处理器里的 kill 是幂等兜底。

### 首次构建失败不冒充「watch 已建立」

`ctx.watch()` resolve 时首次构建的 `onEnd` 可能还没跑（实测），入口不能据此打印成功提示。`buildClient` 在 `onEnd` 里记录首次构建结果，并用 promise 等到首次构建结束，watch 模式下返回 `{ initialBuildFailed }`；失败时打印「watch 已建立，但首次构建失败」，正式产物保持上一份。

## 边界

- **宿主明确不做 react-refresh 级状态保留**：替换 = 拆 fiber 重新 `apply`，插件内 React 状态重置；会话、连接、看板数据在插件之外，保留。
- **宿主无失败回滚**：替换失败后旧 bundle 不再恢复，只能等下一次重建或在 Plugin 列表手动重试。本仓能保证的只有「不主动喂半截文件」。
- 只覆盖 Web 的 SSE 通道；Electron 安装形态与后端重启不走这条。
- `npm start`（日常实例）不挂 watch。需要热替换时手动 `npm run build:client -- --watch`，因为 profile 里本插件是 `link:` 指向工作树，日常实例的页面也会跟着替换。
- watcher 看的是入口的依赖图（含 `src/shared/` 与 `package.json` 的依赖解析）；改 `package.json` 依赖仍要回主 checkout 安装（依赖共享主 checkout 的 `node_modules`）。
- 没有做 `DEV_NO_WATCH` 开关：watch 是 `npm run dev` 的默认行为，只要单次构建的场景直接跑 `npm run build:client`。
- 并发构建只保证「不共写 staging、不撕裂」，不保证最终产物对应最新源码：同树两个构建同时进行时后完成 rename 的赢。需要确定产物时先停 watch 再单次构建。
- 失败路径的 `rmSync(staging)` 是防御性死代码：当前 esbuild 0.28.2 构建失败时不写 staging，删掉它用例也不变红；保留是为了 esbuild 将来行为变化时不留半截临时文件，失败路径用例的「不留 staging」断言目前是空的。
- `initialBuildFailed` 只报告 watch 的首建；后续重建失败只由 esbuild 打印，不改变进程状态。
- 信号退出用 `process.exit(130/143)`，不等待子进程真正退出；kill 已发出，watcher 会自行退出。

## 验证

`npm run check`：**695 例全绿**（新增 5 例，全在 `tests/client-build.test.js`：参数解析 2、真实入口契约 1、基线模块 fixture 1、构建失败保留 1）。

rebase：`git rebase origin/main` 到 `5b40f79`。冲突三处：`README.md`（#58 的凭据说明与本 PR 的 watch 说明取并集）、`build/client.mjs`（保留薄入口，main 的 external 清单迁到 `client-bundle.mjs`）、`scripts/dev.mjs`（#58 的凭据继承/日志/`try` 结构 + 本 PR 的 watch 启动与清理）。`AGENTS.md` 自动合并但语义过时，手工把 `BASELINE_EXTERNALS` 的路径改到 `build/client-bundle.mjs`；`tests/markdown.test.js` 里读同一常量的用例也跟着改路径。

构建：`npm run build:client` exit 0，产物外部 require 三种——`react` ×13、`react-dom` ×3、`@deepseek-ai/dsh-client-ui-primitives` ×1，`lib/` 下只有 `client.js`。

真实 watch 读数（`node build/client.mjs --watch`）：

- 改 `src/client/index.js` 的内容（改动进入产物，如临时 `console.warn`）→ `lib/client.js` mtime 与 size 跟着变；`git checkout` 恢复后再次重建。**只 `touch` 不保证触发**（评审机不触发，本机重复跑也有不触发读数），别拿 touch 当判据。
- 失败路径：入口追加 `const __probe = ;` → 产物 mtime 保持不变、无 staging 残留、watch 打印 `Unexpected ";"`；恢复后自动重建成功。
- 首建失败提示：broken 入口跑 `node build/client.mjs --watch`，打印「客户端 watch 已建立，但首次构建失败…」，不再冒充成功。
- staging 并发：10 个 `node build/client.mjs` 并发，修复后 10/10 exit 0、`lib/` 只有 `client.js`、`node --check` 通过；把 staging 临时改回固定名后 4/10 以 `ENOENT ... client.js.staging` 失败，恢复后回到 10/10。
- 信号清场（`DEV_DSH` 指向 `exec sleep 60` 的假 dsh）：对 `node scripts/dev.mjs` 发 SIGTERM，父、watcher、dsh 三个进程全部退出；只把 SIGINT 发给父进程时同样三者全退。用 HEAD 的旧版 `dev.mjs`（`spawnSync` + `finally`）重复同一探针，父进程死后 watcher 仍存活，随后手动清理。Ctrl-C 的进程组行为是终端语义，未单独构造进程组复现。
- SSE 推送（`curl -N /plugins/events?token=…`）：重建后收到 `{"type":"rebuilt","id":"dsh-leader-agent","rev":"7533752b18c0"}`，graph 里该行 URL 的 rev 同步变化。
- 浏览器替换（`npm run dev` 起的实例，页面全程未刷新）：在 `apply` 里临时加 `console.warn('dsh-leader-agent apply: probe-v2')`，watch 重建后页面 console 立即出现该条——旧 fiber 被拆、新 bundle 重新执行 `apply`。探针用完已还原，不入库。
- 附带读数：同一次重建里改 `sidebar.footer.action` 的 `label`，页面上该按钮的可访问名没有跟着变。宿主按钮文案的渲染路径不读注册 label 或做了 memo，与本通道无关，未据此下结论。

外部清单回归：`tests/client-build.test.js` 的 fixture 直接 import react / react-dom / ui-primitives，断言三者都以 `require(...)` 留在产物外；真实入口用例也断言三者。清单漏项时 esbuild 解析失败或内联会直接变红。

双向验证：把 `BASELINE_EXTERNALS` 清空 → 三个构建用例变红（本仓没装 react，红在 `Could not resolve`）；恢复后全绿。staging 改回固定名 → 并发 10 个构建 4 个 `ENOENT`；恢复后 10/10。删掉 `rmSync` 行 → 用例仍绿（见边界的诚实读数）。
