# e2e 增加桌面版内置宿主的车道

## 背景

桌面版会先于 npm `latest` 发布：2026-11-12 桌面应用内置 `0.2.2-rc.2`，npm `latest` 仍是 `0.2.2-rc.1`，`next` 才是 `rc.2`。e2e 一直用 PATH 上的 npm 宿主，复现不了桌面刚发的行为——0.2.2 的左栏滚动网格就是这样漏到桌面用户，见 `bug-fix/2026-11-12-project-section-sidebar-scroll-grid`。

`engines.dsh` 的下限仍按 npm 包判定，所以 npm 宿主那条车道不能撤；缺的是「用户实际在跑的那一版」的验证入口。

## 决策

- 新增 `npm run e2e:desktop`：用 `ELECTRON_RUN_AS_NODE=1` 让 Electron 以 Node 身份加载 `app.asar` 里的 dsh，生成 `.dev/desktop-dsh` wrapper 作为 `DEV_DSH`，复用 `npm run e2e` 的既有车道与隔离数据根。
- 启动前跑一次 `dsh --version` 并打印 `[e2e] 桌面宿主 <版本>（<app>）`，PR 证据能直接对上版本。
- 强制 `DSH_PROFILE=web`：从桌面版会话里调用时会注入 `DSH_PROFILE=desktop`，而 e2e 夹具按 `DSH_PROFILE` 派生 profile；不压掉会「派生了 desktop、`dsh web` 却读 web」，插件客户端半边根本不挂载。
- `.app` 定位顺序：`DSH_DESKTOP_APP` → 从 `DSH_INSTALL_DIR` 反推 → `/Applications/DeepSeek Harness.app`。只支持 macOS，找不到就报错，不静默退回 npm 宿主。

## 边界

- 只是维护者本机的发版前车道，不进 CI：CI 没有桌面应用，且这条车道证明的是「桌面内置版本」而不是下限版本。
- 不读 `app.asar` 内部：普通 Node 读不了 asar，只有 Electron 的 fs 能读；路径按桌面版的相对结构写死，结构变了会在 `--version` 探测处大声失败。
- wrapper 只做转发，不解析输出；`dev.mjs` / `desktop.mjs` 那套 profile 逻辑一概不碰。

## 验证

- `npm run e2e:desktop`：打印 `[e2e] 桌面宿主 0.2.2-rc.2（/Applications/DeepSeek Harness.app）`，全量 8/8 通过（本分支尚无 `project-placement` 用例）。
- 同一桌面宿主跑 #133 分支（手动 wrapper）：含新增落点用例的全量 9/9。
- npm 宿主对照：`0.2.2-rc.1` 全量 9/9、`0.2.2-rc.2` 全量 9/9（#133 分支，串行）。
