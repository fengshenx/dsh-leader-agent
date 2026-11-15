# Agent Note: Agent Note 的格式交给机械门禁，不靠记性

Status: implemented

> **部分已被 [Agent Note 双轴](2026-11-03-agent-note-lifecycle-and-class.md) 与 [宿主 Agent Note 格式对齐](2026-11-16-host-agent-note-format-alignment.md) 取代**：路径双轴、按 lifecycle 的必需节与笔记间链接可达由双轴篇接手；`Status:`、`## Alternatives considered` 与英文骨架由宿主对齐篇接手，本文的「不照搬宿主骨架」不再成立。保留「为什么需要机械门禁」「只查结构不查内容」与「无祖父条款」三条决策。

## Problem

`npm run check` 原来只做 `node --check` 与 `node:test`，`.agents/notes/` 的结构全靠人。代价当场付过一次：新笔记按「一个问题一节」写，没有 `## 背景` / `## 决策`，人和 review bot 都没发现，是用户读出来才改的——散文规则要在写的时候被想起才生效，机械门禁一定会被执行。

## Decision

判定与 IO 分开：`agent-note-format.mjs` 判结构，`agent-note-audit.mjs` 读盘并拼违规项，`verify-agent-note-format.mjs` 只调入口并给退出码；首版规则是「文件名日期 / 唯一 H1 / 首节背景 + 有决策 / 节名不重复」，后续扩展见双轴笔记。

**不照搬宿主骨架**（`# Agent Note: <title>` + `Status:` + `## Problem` / `## Decision` / `## Alternatives considered` / `## Consequences`）：本仓原有笔记已按 `背景 / 决策 / 边界 / 验证` 写，换成英文节名要重写每一篇，收益只是「和上游长得一样」。门禁管的是自洽，不是同形。

## Alternatives considered

- **照搬宿主骨架**（`# Agent Note: <title>` + `Status:` + 英文节名 + `## Alternatives considered`）：当时本仓笔记已按 `背景 / 决策 / 边界 / 验证` 写，重写每一篇的收益只是「和上游长得一样」；**2026-11-16 已推翻，改为完整对齐宿主**，见 [host-agent-note-format-alignment](2026-11-16-host-agent-note-format-alignment.md)。
- **只靠人记**：散文规则要在写的时候被想起才生效，代价已付过一次（新笔记没有背景/决策）；机械门禁一定会被执行。
- **门禁顺手查内容**：篇幅、流水账、验证读数要读得懂中文并知道改动做没做；机械层只判结构。

## Consequences

- **只查结构，不查内容**：篇幅、是不是流水账、验证有没有读数、决策有没有写理由，门禁一概不管——那要读得懂中文并且知道这个改动做没做。
- **不强制 `## 边界` 与 `## 验证`**：历史笔记里有只有「背景 / 决策 / 证据」的，硬性要求会逼人补写本不存在的验证内容，那是给门禁凑数，比缺一节更坏。
- **只查日期在日历上合法**，不查与 git 首提时间是否一致——那得问 git。
- **没有祖父条款**：宿主给旧笔记开了豁免，本仓一次性重排完，不留豁免通道，免得「豁免」变成新笔记的默认出路。

收益：笔记结构从靠记性变成靠门禁，漏节在 `npm run check` 就红，不再等用户读出来。

## Testing

`tests/agent-note-format.test.js`；双向读数：把某篇笔记的 `## 背景` 改回 `## 问题` → 门禁退 1 并报「第一节必须是 `## 背景`」，还原后退 0。
