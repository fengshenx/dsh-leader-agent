# 覆盖率门禁：分母来自目录枚举，不是报告

2026-11-03。

## 背景

本仓此前没有任何覆盖率配置：`package.json` 没有 coverage 脚本、没有 coverage 依赖，`npm run check` 末尾是裸 `node --test tests/*.test.js`，全仓搜 `coverage` 只命中 CSS 的 `100%`。

用 Node 内置覆盖率实测，`all files` 行覆盖 96.85%，看起来体面；但 Node 只统计**被加载过**的文件：`src` 下 17 个文件、5,797 行（占 `src` 总量 34%）从未被单测 import，既不在报告里也不算 0%，这个数字因此虚高。缺失集中在 `src/client/`：`project-section.js`（1,094 行）、`board-styles.js`（983 行）、`project-panel.js`（709 行）等 React 组件与 CSS 模板，单测没有渲染环境，行为只由 `npm run e2e` 覆盖。

宿主仓库对覆盖率是另一套强度：`pnpm run test:coverage` 是 CI 门禁，`packages` 下每个包的 `src` 要求 per-file 100% 行覆盖（宿主 `AGENTS.md:87`、`docs/testing.md:10`），对真机依赖逐条显式豁免而不是放宽阈值。本仓要对齐这个强度，先要解决的不是「补测试」，而是「分母可信」。

## 决策

### 分母来自 src 目录枚举

`scripts/verify-coverage.mjs` 把 `src/**/*.js` 的枚举结果当分母：报告里没有、清单里也没有的文件直接红，提示「补测试，或在 unmeasured 里写明理由」。

不能靠旗标解决：实测 `--test-coverage-include='src/**/*.js'` 只是过滤**已加载**的文件，未加载文件仍然不出现；`--test-coverage-lines` 是全局阈值，报不出是哪个文件掉下来。所以要自己解析表格，并按目录树缩进还原完整路径（表格的「file」列只有文件名）。

### per-file 门槛：默认 100%，存量按整数记账

没登记门槛的文件一律要求 100%，与宿主同口径。存量欠账登记在 `scripts/coverage-manifest.json` 的 `thresholds`：整数下限 + 为什么没补的理由。掉到门槛以下即红；涨出门槛 1 个百分点以上会打 `RAISE` 提示，让门禁自己催着往上抬。

取整数下限是有意的：账面最多落后实测不到 1 个点，但 Node 版本升级带来的浮点漂移不会误报。代价是 1 个点以内的回退不会变红，需要更严时把实测值原样写进去。

### 豁免必须写理由，且反向校验

单测 import 不到的文件登记在 `unmeasured`，值是一句具体理由（React 组件、CSS 模板、依赖宿主模块表的适配层各自说明）。登记了却出现在报告里同样红——否则豁免清单会慢慢变成「什么都不测也绿」的垃圾桶。清单里的路径必须真实存在于 `src/` 下，改名或删除要在同一次改动里更新，否则红。

### 用默认 reporter 解析表格

实测 `--test-reporter=dot` 时 Node 不打印覆盖率表格（stdout 只有测试输出），自定义 reporter 会抑制覆盖率报告。门禁因此不传 reporter，用默认的 spec 输出，从 `ℹ` 开头的行里挑表格。

### 接进 check，替代裸 node --test

`npm run check` 末尾从 `node --test tests/*.test.js` 换成 `npm run test:coverage`：测试只跑一遍，覆盖率插桩在同一遍里完成。子进程经 `scripts/spawn-command.mjs` 起——`scripts/` 不许直接引 `node:child_process`（Windows shim 门禁，`tests/spawn-command-usage.test.js`）。

## 边界

- 门禁只判 `src/**/*.js`。`index.js`（纯 re-export 入口）、`scripts/`、`build/` 不进分母，与宿主只 gate 各包 `src` 同口径。
- 只判行覆盖，分支与函数覆盖只呈现不设门槛。行覆盖必要不充分——100% 证明行被执行过，不证明行为对（宿主 `docs/testing.md` 同一说法）。
- 分母完整性只能由入口脚本守：`tests/coverage-gate.test.js` 判解析、判定逻辑与清单自身合法性，「报告里缺了谁」要跑测试才知道，单测判不了。
- 覆盖率与 e2e 是两条证据：登记进 `unmeasured` 不等于该文件被验证过，client 组件的行为仍归 `npm run e2e`。
- 客户端组件一旦抽出纯函数、能被单测 import，就该从 `unmeasured` 移到 `thresholds` 或直接 100%——清单过期会由「登记了却出现在报告里」这条判据当场报出来。

## 验证

- 新增 13 条单测（`tests/coverage-gate.test.js`）：表格解析（目录缩进还原、非表格行跳过）、未登记未加载、低于门槛、高出门槛提示、豁免掩盖已测文件、清单路径消失、理由缺失、门槛非法、真实清单自身合法性、同一文件不重复登记。
- 首跑读数：`verify-coverage: 68 个源文件，51 个被单测加载（33 个行覆盖 100%），17 个登记为单测不可加载`；被加载的 `src` 文件按行数加权约 97%（`dispatch.js` 97.14%、`projects/service.js` 95.87%、`project-board-monitor.js` 63.16% 是三处最低）。
- 双向验证（每条先红后绿，退出码取自 `node scripts/verify-coverage.mjs`）：
  - A 新增未登记文件 `src/shared/zz-unregistered.js` → `NONE —% / —% src/shared/zz-unregistered.js`、`1 项未通过`、exit 1；删除后绿。
  - B 把 `dispatch.js` 门槛从 97 抬到 100 → `LOW 97.14% / 100%`（未覆盖行号一并列出）、exit 1；还原绿。
  - C 把 `src/client/markdown.js` 从 `unmeasured` 挪进 `thresholds` → 「登记了门槛但这个文件没被任何单测加载」、exit 1；还原绿。
  - D 把已加载的 `src/host/message.js` 登记进 `unmeasured` → 「登记为单测不可加载，但它出现在覆盖率报告里」、exit 1；还原绿。
- 文档体量：`AGENTS.md` 3,680 → 天花板 3,930 抬到 4,050（3680 × 1.10，10% 余量）；`docs/development.md` 1,828 → 天花板 1,780 抬到 1,930（1828 × 1.05）。两者都是新增一节机制说明，不是把细节塞进现有规则。
- `npm run check`：913 tests / 904 pass / 9 skipped / 0 fail；Agent Note 门禁、文档工具名、文档预算、语法检查与覆盖率门禁全过。
