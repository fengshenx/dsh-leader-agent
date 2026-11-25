# Agent Note: LaunchServices 不投递 open --env 时跳过真实启动用例

Status: implemented

## Problem

`tests/desktop-remove.integration.test.js` 的「假 .app 启动」用真实 `open --env DSH_HOME=...` 拉起 fake app，等它把数据根写进 capture。但在沙箱、无 GUI 会话或部分系统版本上，`open` 退出码仍是 0，`--env` 却被静默丢掉：fake app 拿空 `DSH_HOME`，capture 永远等不到目标内容，用例白等 30 秒后变红。`npm run check` 因此在这些环境里无法全绿，而失败信息容易被人误读成 main 回归。手动验证：同一个 fake app 用 `open --env` 拉起后读不到变量，用编译型 app 复核同样为空，排除 shell 或脚本因素。

## Decision

- 真实启动用例开跑前先做一次能力探测：建一个最小的 fake app，用 `open --env DSH_HOME=<探针根> -n -a` 拉起，最多等 5 秒看它是否把探针根写进 capture。
- 探不通就用 `t.skip()` 跳过整条真实启动用例，跳过文案写明「本机 LaunchServices 不投递 `open --env`（沙箱、无 GUI 会话或系统限制）；真实启动用例跳过，请在桌面会话单跑本用例复核 `npm run desktop`」。
- 探通时行为不变：仍然用真实 `open` 跑 dev / prod / 再 dev 三段，30 秒窗口照旧。
- 探测与等待共用一个 100ms 间隔常量；探测不设置 `DSH_HOME` 到测试自己的根以外，fake app 只写探针子目录。

## Alternatives considered

- **继续靠 30 秒超时并让维护者单跑**：失败发生在 `npm run check` 里，不能要求每个跑门禁的人都手工判断这是环境还是回归；30 秒 × 多次等待也很贵。
- **总是用假 `open` 替换真实通道**：能测 `desktop.mjs` 的参数拼接，但就不再验证 OS 的 `open --env` 链路；把系统限制换成测试假件会掩盖真实环境差异。
- **始终跳过 macOS 启动用例**：正常的桌面会话本来能验证，全部跳过会让唯一一条真机启动断言失效。
- **把超时预算调大**：`open --env` 是静默丢弃变量，不是慢；等多久都不会变绿，只会更慢。
- **改生产启动方式**：`open --env` 仍是 macOS 给 .app 注入环境的文档通道；本次只处理不可测环境，不改启动机制。

## Consequences

- 沙箱/无 GUI 环境下 `npm run check` 通过，代价是多一条明确的 skip；测试输出直接指出被跳过的原因与人工复核入口。
- 探测通过的环境仍跑真实启动；这条用例的价值没有整体丢掉。
- 不掩盖生产风险：跳过的文案明确要求到桌面会话复核 `npm run desktop`，此次本机无法证明该通道可用。
- 单次测试多约 5 秒探测预算；比原来每个启动等 30 秒失败便宜。

收益：环境限制不再把 `npm run check` 变成红的，同时保留健康 macOS 上的真实 LaunchServices 验证。

## Testing

本机单跑 `node --test tests/desktop-remove.integration.test.js`：11 条中 10 pass / 1 skip，跳过的是真实启动用例，原因写明 LaunchServices 不投递 `open --env`；其余摘除、影子根、拒绝启动用例照旧通过。探测逻辑的双向验证：把探测改为恒 `true` → 用例回到 30 秒超时红；还原后跳过并全绿。
