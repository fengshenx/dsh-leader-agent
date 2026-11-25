# Agent Note: e2e 只测行为与逻辑，不测样式

Status: implemented

## Problem

浏览器 e2e 曾断言计算样式与像素几何：项目行与宿主工作区的行高、内边距、左边缘，标签栏高度与控件坐标，预览圆点取色，done 区字号，引导卡与输入框对齐，头像动画等。它们把宿主的 CSS 实现写进回归：宿主只改排版，功能没变，e2e 先红，维护者要对照像素改断言。插件消费宿主公开 DOM 契约，不拥有宿主排版，样式不是本仓的契约面。

## Decision

- e2e 只断言行为与逻辑：DOM 结构、存在、属性、可见性、文案、ARIA 状态、交互结果、落盘数据与 wire。
- 不写样式断言：颜色、字号、圆角、动画、像素位置与尺寸、布局对齐（计算样式值、`boundingBox`、`getBoundingClientRect`）都不进 e2e。
- 只守几何对齐的 `project-alignment` 场景整条删除；`project-placement` 只保留 portal 落点结构（落点容器、文档顺序、不退回 footer），去掉宽高。
- 混合场景只删样式段，行为断言保留；原先用计算 `display` 判可见性的地方改读元素可见性。
- 规则归属 [docs/e2e-testing.md](../../../../docs/e2e-testing.md) 与 [e2e-scenarios 技能](../../../skills/e2e-scenarios/SKILL.md)。截图仍可取证，但不作为回归。原 e2e 方案的机制与确定性规则见[宿主方案笔记](2026-11-04-e2e-host-approach-and-determinism.md)。

## Alternatives considered

- **保留样式断言，宿主改版时只调数值**：红的是像素不是行为，且每次宿主 CSS 变化都要改测试。
- **视觉快照或截图 golden**：本仓没有受评审的 UI 快照所有权，跨机器渲染差异会让快照周期性红。
- **样式下沉单测**：布局要浏览器排版引擎，单测拿不到渲染结果。

## Consequences

- 宿主改 CSS 不再让 e2e 变红；样式回归没有自动门禁，人工取证按 [docs/e2e-testing.md](../../../../docs/e2e-testing.md) 截图并写读数。
- 场景更短更稳，等待目标从坐标回到「存在、可见、可交互」；harness 的失败诊断不受影响。
- 代价是纯布局回归只能靠人眼发现，这是明确接受的取舍。

收益：e2e 只对行为负责，与宿主版本的耦合面收窄到公开 DOM 与数据契约。

## Testing

`npm run check`；受影响的 e2e 场景用 `npm run e2e:one` 逐条跑，剩余场景用 `npm run e2e` 全量确认。
