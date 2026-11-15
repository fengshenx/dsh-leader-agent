# 浏览器 e2e 车道

## 背景

浏览器侧证据长期只有一份「取证规范」：没有可执行落点，每次「证明界面真的这样」都靠临场点一遍，结论不可复现、也进不了回归。宿主的 `apps/web/tests/` 是成熟车道，但它的 `scaffold.ts` 在进程内 import 宿主 cordis 树与 replay 包，与本仓「不 import 宿主内部包」冲突。

## 决策

- **黑盒实例**：`mkdtemp` 建数据根，复用 `scripts/dev-instance.mjs` 派生 profile（与 `npm run dev` 同一份组合），spawn `dsh web --port 0 --no-open`，从 `dsh web: <url>` 就绪行取带 token 的地址。端口用 `--port 0` 而不是扫空闲端口，token 只从就绪行读——两者都只能来自本次运行。
- **mock 按 prompt 标记驱动**：自建零依赖 `node:http` 实现 Messages SSE，按用户消息里的 `MOCK-*` 标记查脚本，脚本按请求顺序消耗，没有标记时沿用上一次命中的标记（两轮场景靠这条），仍没有就 400，不猜。
- **宿主自己的附带调用单独归类**：宿主给会话起标题时 prompt 带着用户原文，标记会出现在里面；`classifyRequest()` 按 system prompt 把它归为 `title`、回固定文案、不消耗游标，`mock.requests` 每条带 `kind`，断言只数 `scenario`。
- **跑道用 `node:test`**：`node:test` + `playwright` core，不引 `@playwright/test`；`npm run e2e` 先 `build:client`——缺 `lib/client.js` 时插件在界面上什么都不显示，宿主却照常启动、不报错。
- **起进程统一走 `scripts/spawn-command.mjs`**：`npm` / `dsh` 一律经 `spawnCommandSync` / `spawnCommand`；`tests/spawn-command-usage.test.js` 静态守线：引入 `node:child_process` 的文件必须在允许清单里，判据是模块说明符（命名、命名空间、默认导入、`require`、动态 `import()` 落在同一段字符串上），注释里提到也算。
- **截图走同一套夹具**：`e2e.screenshot(label)` 存到 `.dev/e2e-artifacts/<场景名>-<pid>/`，`stop()` 前自动存 `final.png`，路径打到 stdout 供人直接打开。截图只是证据，回归仍靠断言，不写「截图里有某个字」。
- **e2e 不进 `npm run check`**：check 只跑纯函数与假件；可判定部分（标记解析、脚本游标、SSE 事件序列、就绪行解析、显式端点检测）抽成纯函数进 check，需要真浏览器的留 `tests/e2e/*.e2e.js`。

## 边界

- 不覆盖原生控件、浮层像素与动画观感、WebKit/Firefox；继续人工取证并在 PR 里标注「未 GUI 实测」。
- 不做 aria golden 与 snapshot refresh：断言锚是 DOM class、计算样式与落盘文件。
- 不为 e2e 改生产代码；需要新选择器时那是一次产品决定，不夹带。
- 跨进程拿不到 `whenIdle()`，轮次完成只能从浏览器侧观察（回复上屏、落盘文件出现）。
- 显式 `baseURL` 会让 mock 静默失效：派生 profile 时检测 `cordis.yml` / `cordis.patch.yml`，命中直接报错。
- 会话落盘格式归宿主：两种后缀都认、解压失败视为「还在写」，不硬编码路径与版本号。
- mock 游标是全局单值，一轮只支持一个会话在请求模型；协调者 + worker 并行前要先按 session id 分游标。
- 需要 Node 22.15+（`node:zlib` 的 zstd），旧版本是 import 期就崩。

## 验证

`tests/spawn-command-usage.test.js`、`tests/e2e-logic.test.js`、`tests/e2e-mock-script.test.js` 钉住门禁与纯函数；双向读数：把场景里的标题断言改错 → 用例超时变红，把 mock 游标改成不吃标记 → 等回复超时变红，还原后全绿。
