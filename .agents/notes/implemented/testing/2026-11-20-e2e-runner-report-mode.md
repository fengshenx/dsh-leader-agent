# Agent Note: e2e 单场景入口与 report 模式

Status: implemented

## Problem

e2e 原先是一条 POSIX shell 循环：`for f in tests/e2e/*.e2e.js; do node --test "$f" || exit 1; done`。第一个 flaky 场景就把整轮打断，后面的场景一个都看不到；没有单场景入口，只能记住 `node --test` 的路径并自己先构建；也没有最后的 PASS/FAIL 汇总，CI 日志里只剩一个失败文件。本机 load ~54 时 `guide-card`、`board-done-paging`、`avatar` 等多个场景在 15 秒等待处超时，空载单跑却通过；没有已知 flake 登记表，多个 worker 各自重复踩并把环境噪声误判成自己的改动。

## Decision

- 新增 `scripts/e2e-run.mjs`，三种模式共用「每个场景一个独立 `node --test` 进程」：`one` 只跑一个文件；`fail-fast` 按文件名顺序跑，第一个失败立刻停；`report` 按顺序跑完所有文件，最后打印 PASS/FAIL 与失败文件，任一失败退出 1。
- `package.json` 增加 `e2e:one`/`e2e:report`；`e2e` 保持 fail-fast，保留 CI 语义。`e2e:one` 接受文件或场景名，都会先 `build:client`，并保留 `.dev/e2e-artifacts/`；不自动清理、不重试。
- `docs/e2e-testing.md` 增加单场景/全量/报告入口、负载卫生、失败处理顺序、已知 flake 表与超时口径；`e2e-scenarios` 的失败诊断只链接到该 playbook，不复制操作正文。
- 已知 flake 先登记、再追根因；单跑通过不等于修好。等待预算只允许按 `E2E_BUDGET_SCALE` 整体放大慢机/2 核 CI，不能按单个失败点加秒数。

## Alternatives considered

- **所有入口都改成不中断的 report**：CI 会在一处已坏的环境上继续跑完所有场景，既拖长反馈，又让后续失败互相污染；第一个失败已经足够阻断合并。因此 report 只留给本地看全量景观。
- **保留 shell 循环，另加一个 report 脚本**：两套入口的选择/退出码/摘要逻辑会漂移；收进一个 runner，`e2e` 和 `e2e:report` 共用同一份文件发现与单文件执行。
- **失败自动重试**：重试只会把竞态藏起来，违反现有「默认不开重试」的纪律；要区分 flake 与回归，靠空载单跑 + 登记表，不靠第二次侥幸。
- **把所有场景塞进一个 `node --test` 进程并行跑**：现有夹具按文件隔离实例与端口，并行会放大资源竞争；report 明确串行，和原车道语义一致。
- **把 15 秒等待调大当修复**：会掩盖「元素没渲染/数据没到」的根因，只把失败拖长；保留默认值，另给慢机倍率。

## Consequences

- `e2e` 仍然 fail-fast，CI 不会因为 report 模式变慢；`e2e:report` 失败时一定会退非零，不会被汇总「平均掉」。
- report 的最后一行汇总不能替代第一条失败读数：失败后仍要回到单场景、截图、`problems` 与 `instance.logs`，并登记 flake。
- 同一台机器同一时刻只允许一个 e2e 车道；需要多 worker 推进时用 `--files` 拆成互不重叠的小集合并错峰执行，不能把全量 report 当并发入口。
- 不引入重试、不并行、不改现有场景断言；`e2e:one` 会保留 `.dev/e2e-artifacts/`，临时证据仍不入库。
- 文档天花板从 2670 抬到 4160（当前 3875，余量约 7.4%）：新增的是操作面与 flake 表，放在 `docs/e2e-testing.md` 这个归属层；没有新建旁路文档。

收益：一次全量失败能先看到完整景观，定位单个场景不再需要记底层命令或先手动构建；CI 仍然在第一个失败处快速止损。

## Testing

- `npm run e2e:one tests/e2e/board-card-delete.e2e.js`：单场景通过，保留截图目录并打印路径。
- 临时放一个必败场景（不入库），用 `e2e:report -- --files <必败> <两个正常场景>` 验证小集合：汇总 PASS/FAIL、失败文件、退出码 1；`e2e -- --files <同一组>` 只跑到第一个失败就停。验证完删除临时场景。
- `npm run check`：文档预算、工具名、Agent Note 格式、语法与覆盖率全绿。
