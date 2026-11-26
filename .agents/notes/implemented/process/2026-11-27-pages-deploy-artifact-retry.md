# Agent Note: Pages 部署在工件查找失败时重试 deploy

Status: implemented

## Problem

上游客服端 bug（[actions/deploy-pages#451](https://github.com/actions/deploy-pages/issues/451)）：
`deploy-pages` 在 `upload-pages-artifact` 之后立刻按名字查 `github-pages` 工件，偶尔查到 0 个，
而工件其实已经上传成功。2026-11-26 的 run [45856148150](https://github.com/fengshenx/dsh-leader-agent/actions/runs/45856148150)
就是这个形态：上传在 16:10:03.5 完成，deploy 在 16:10:03.7 报 `Found 0 artifact(s)`；
两分钟后同一个 run 的工件列表里，`github-pages` 正常存在。之前 11-24 也失败过一次、手动重跑即成功。
失败期间 main 上的 `site/` 更新没有上线，线上仍是旧版链接。

## Decision

- `deploy` 失败后重跑 `deploy-pages`，等待依次 5s / 20s / 60s（沿用 [jvt.me 的实测工作法](https://www.jvt.me/posts/2026/11/25/github-pages-artifacts-bug/)）。
- **只重试 deploy，不重试 upload**：同一 run 里出现两个 `github-pages` 工件，查找会从「找不到」变成「找到多个」，同样失败。
- 前三次 `continue-on-error`，最后一次失败照常让 job 红；`environment.url` 按成功的那次取 `page_url`。
- 理由写成 workflow 里的注释，上游修复（[#455](https://github.com/actions/deploy-pages/pull/455) 发布）后删掉重试。

## Alternatives considered

- **轮询 REST 工件列表再 deploy**：deploy-pages 查工件的接口与 REST API 不同步，轮询到了它仍可能查不到；jvt.me 实测无效。
- **把 upload 与 deploy 拆成两个 job**：只是多等几秒启动时间，命中概率降低但仍会复现；不如重试确定。
- **升级到 `upload-pages-artifact` v5 + `deploy-pages` v5**：v5.0.1 仍未包含修复，升级解决不了这个问题，还会引入未验证的大版本变更。
- **失败了人工点重跑**：正是现状——线上会旧几个小时，且每次都要有人盯。

## Consequences

- 只有失败时才付出等待：最坏 85 秒，成功路径不变。
- 每次重试都会在 job 里留下一个红色旧步骤，但最终结论由最后一次决定；同一 commit 重复部署内容相同，不会造成可见错误。
- 修复来自上游；本仓的等待时长与步骤数量是经验值，不是保证。

收益：Pages 因工件查找竞态失败的部署能自愈，`site/` 更新不再需要人工重跑。

## Testing

`actionlint` 通过。`github-pages` 环境保护规则只允许 main 分支部署，新 workflow 没法在功能分支实跑；
用 `workflow_dispatch` 在 main 上重跑一次把线上恢复到 `89dc23e`，`site/index.html` 与仓库一致。
重试路径要等合并后第一次命中该竞态才会走到。
