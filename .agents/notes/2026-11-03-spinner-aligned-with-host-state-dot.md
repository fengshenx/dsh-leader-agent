# 运行中加载圈改用宿主 StateDot

**状态**：implemented（2026-11-03）
**范围**：`src/client/project-section.js`、`tests/project-panel.test.js`、`docs/architecture.md`、`docs/limitations.md`

## 背景

项目行与会话行的运行中指示各有一个自绘 span：`border: 1.5px solid` + `border-top-color: transparent` + `0.8s linear` 旋转。它和宿主自己的加载器不是一套东西，肉眼三处不同：

- 转速：0.8s 对宿主 1.5s；
- 形状：10px 直径上 1.5px 边框的缺口环，对 SVG 双环（`opacity: .25` 的整圈轨道 + `stroke-dasharray: 12 150` 的呼吸弧、`stroke-linecap: round`）。小尺寸下边框环被抗锯齿磨得不像正圆；
- 相位：宿主的 `StateDot` 在挂载与每次 `animationstart` 时把所有动画的 `startTime` 归零，页面上多个加载器同相；自绘版每个元素插入时各自起步，项目行与会话行两个圈各转各的。

宿主还在 `prefers-reduced-motion: reduce` 下停掉旋转，自绘版没处理。

## 决策

**两处渲染都改成宿主基线模块的 `StateDot`（`state: 'ongoing'`），删掉自绘样式与关键帧。**

- 组件来自 `@deepseek-ai/dsh-client-ui-primitives`，与 `MarkdownText` 同一条路径：`PLATFORM_MODULES` 基线模块、构建期 `BASELINE_EXTERNALS` 留在产物外、运行时同一实例。`dsh-v0.2.1-rc.2` 的 `index.ts` 已导出 `StateDot`，下限版本可用。
- 不传 `size`：`ongoing` 默认 14px，与官方会话行 `Rows.module.css` 的 `.slot`（16×20）里放的是同一尺寸；本仓 `.dsh-leader-kit-session-status` 与 `.dsh-leader-kit-project-lead` 也是同一个槽位。
- 装饰语义由组件自带（`aria-hidden="true"`），不再手写。
- 删掉 `.dsh-leader-kit-project-spinner` / `.dsh-leader-kit-session-spinner` 两条规则与 `@keyframes dsh-leader-kit-spin`，全仓不再有第二套加载圈。

**行首槽位容器 `.dsh-leader-kit-project-lead-folder` 补 `display: inline-flex` 与居中。** 换成 SVG 后暴露出既有的布局缺口：这层 span 没有任何布局规则，SVG 按行盒基线排，槽位被 line box 撑成 17px，14px 的圈中心比 34px 行的中心高 1.5px。原来的自绘圈是 `display: block` 的 12px 空 span，在 inline 父级里自成块、恰好落在行中心，问题被掩盖了。撑成 flex 后圈与 16px 目录图标都以行中心对齐，互相切换零跳动。

## 边界

- **项目行加载圈不再跟随激活色**：自绘版用 `currentColor` 继承槽位容器的 `color`（组内有当前会话时是 `state-business-primary`），`StateDot` 的 `.spinner` 固定 `label-tertiary`。这是「和宿主一致」的代价——宿主自己的会话行也是三级标签灰；组内激活态仍由文件夹图标承担，只是运行中时图标换成灰圈。
- 只覆盖运行中，不覆盖待输入 / 已完成 / 空闲：本仓的会话行只区分「在跑」，其余状态宿主自己的行有。
- 尺寸从 10px（会话行）/ 12px（项目行）统一到 14px，行高不变（槽位 16×20 包住 14px 的圈）。
- 行首图标随槽位改为 flex 一起修正：之前按基线排也偏上 1.5px，现在落到行中心，视觉位置比旧版低 1.5px。这是对齐修正，不是新样式。
- 未做「真实运行中」的真机视觉取证：要造这个态需要协调者会话正在请求模型或执行工具，隔离实例里要么接真实模型、要么走派工链路 + 按 session 分游标的 mock（`docs/e2e-testing.md` 记了这条限制）。本轮证据是「组件来自宿主基线、宿主产物 CSS 已含状态样式、产物 require 形态正确、真实样式下的几何读数」四段。

## 验证

- `npm run check`：900 tests / 891 pass / 9 skipped / 0 fail。
- 双向验证（逐条撤销 → 变红 → 还原）：
  - 项目行改回 `createElement('span', { className: 'dsh-leader-kit-project-spinner' })` → 「协调者运行态接线到行首加载圈」1 fail（50 pass / 1 fail）；还原 → 51 pass。
  - 会话行改回 `createElement('span', { className: 'dsh-leader-kit-session-spinner' })` → 同一条用例 1 fail；还原 → 51 pass。
- 接线守卫改为钉住两处 `createElement(StateDot, { state: 'ongoing' })` 与 `import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'`，并断言自绘类名、`@keyframes dsh-leader-kit-spin`、`data-running` 全部不再出现——回退到自写圆环会立刻红。
- 产物读数（`npm run build:client`）：`lib/client.js` 里 `createElement(import_dsh_client_ui_primitives2.StateDot, { state: "ongoing" })` 2 处（项目行、会话行），`dsh-leader-kit-spin` / `project-spinner` / `session-spinner` 0 处。
- 宿主产物核对：`apps/web/dist/assets/index-*.css` 含 `._spinnerArc_*`（`stroke-dasharray:12 150` + `1.5s ease-in-out`）、`._spinnerTrack_*`（`opacity:.25`）与 `_dsh-state-dot-spin_*` 关键帧——样式随宿主 web bundle 一起加载，不靠插件自带。
- 垂直对齐读数（从 `lib/client.js` 抽出 `STYLE_TEXT` 的真实规则，配同构 DOM：项目行 / 会话行 / 槽位 / 14px 双圆 SVG，无头 Chromium 读 `getBoundingClientRect`）：
  - 修复前（槽位是普通 inline span）：槽位高 17px，圈中心 61.5、行中心 63 → `offsetFromRowCenter: -1.5`；
  - 修复后：槽位高 14px，圈中心 = 行中心 = 21 → `offsetFromRowCenter: 0`；
  - 同槽位的 16px 目录图标中心同为 21，`spinnerVsIconShift: 0`（运行态与空闲态切换不跳动）；
  - 会话行本来就在 `inline-flex` 的 `.dsh-leader-kit-session-status` 里，偏移一直是 0。
- 双向验证（对齐这一层）：删掉 `.dsh-leader-kit-project-lead-folder` 的 `display: inline-flex` → 新断言 1 fail（50 pass / 1 fail）；还原 → 51 pass。
- 未 GUI 实测：真实 running 态下的旋转观感，见「边界」。
