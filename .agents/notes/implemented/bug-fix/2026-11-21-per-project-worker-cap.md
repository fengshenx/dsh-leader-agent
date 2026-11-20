# Agent Note: worker 名册上限按项目计

Status: implemented

## Problem

`spawn_worker` 的 50 条上限读的是全局 worker 登记表：`describeRoster()` 把所有未归档记录都算进 `total`。同一台机器并行多个项目时，A 项目攒满 50 条就把 B 项目的 `spawn_worker` 也堵死，而 B 的名额可能一条都没用；到顶提示里的可复用候选还会混进别的项目的 worker（它们的 cwd 是另一个项目目录，拿去续聊只会做错项目）。默认上限的注释写的是「这个项目还留着多少条工」，实现与语义不一致。LRU 排序、`lastUsedAt` 与到顶提示的其余口径见[上一版笔记](../feature/2026-11-20-slot-release-evidence-and-worker-lru.md)，本次只改作用域。

## Decision

- 名册只看调用方会话所属项目：`describeRoster(scopeSessionId)` 先解析项目，再用「本项目的 leader 会话 + `retiredLeaderSessionIds`」集合过滤 worker 的 `parentSessionId`。
- 归属复用派工登记已有的父会话指针，不新增字段：worker 只由 leader 派（派工前过 `assertLeader`），换 leader 时 `reassignParent` 把原班 worker 改绑到新会话，所以父会话 id 落在项目集合里就是本项目的工。
- 解析不出项目时退回全局口径（缺少 `resolveProject` 的退化装配，或索引还查不出这条会话），与改动前一致；生产装配始终走项目口径。
- `activeWorkerLimit` 的语义改为「每个项目」；到顶提示改称「本项目未归档的 worker 已达上限」，候选、挂卡单列与 `force` 逃逸都只作用于本项目。

## Alternatives considered

- 每条登记记 `projectId`：要在派工时异步解析项目、给旧表做迁移，删项目重建后还会漂移；父会话指针已经能推出归属，多存一份反而多一个要对齐的真源。
- 逐 worker 用 `resolveProject(childId)` 反查 cwd：语义直接，但每次解析都会 `stat` 项目目录，名册一遍要付 N 次 stat；用父会话集合判定是 O(1)，且与项目树同源。
- 按「是否挂本项目卡」判断：不挂卡的 worker 会被漏算，而它们同样常驻、同样占名额。
- 把上限做成配置项：本次只修作用域，数量仍固定 50；配置面另开。

## Consequences

- 一个项目到顶不再影响别的项目；每个项目各自 50，总会话数上限随项目数增长，由用户控制项目数量。
- 父会话推不出归属的登记记录（手写或损坏的 `workers.json`）不计入任何项目，也就不会触发上限；名册是软性护栏，不为这类记录报错。
- 到顶候选只列本项目，不会再推荐别的项目的 worker 来「复用」。
- 旧登记表无需迁移：归属每次现算，不落新字段。

收益：并行项目的 worker 名额互不挤占，到顶提示只给本项目真正可复用的选项。

## Testing

- `tests/dispatch.test.js` 新增：别的项目攒满不占本项目名额、到顶提示只列本项目候选、退役 leader 派的 worker 仍算本项目名额。
- 双向验证：临时去掉 `describeRoster` 的项目过滤，前两条用例变红；还原后全绿。
- 既有到顶、已归档不占名额与 `force` 用例不传 `resolveProject`，继续钉住退回全局口径的路径。
