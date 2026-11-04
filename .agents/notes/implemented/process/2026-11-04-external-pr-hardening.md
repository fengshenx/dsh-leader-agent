# 对外开放 issue/PR 的三道入口防线

## 背景

仓库此前是单人闭环：PR 都由维护者自己开，main 的 ruleset 只有禁删、禁强推、强制走 PR 三条，没有 required status checks——CI 绿不绿不影响合并。准备开放外部 issue 与 PR 之后，威胁模型变了：PR 可以改自己的 workflow 文件、可以从 fork 带来未审阅的提交、issue 入口会迎来大量缺少版本与复现步骤的报告。

## 决策

### required check 只认聚合 job `ci-ok`

矩阵按 Node 版本展开成 `check (24.9.0)` / `check (24)` 两个 check 名。分支规则可以登记多个，但改 matrix 的当天旧名字就消失了，所有 PR 会一直等一个不会再出现的 check（显示 expected，无法合并）。`ci-ok` 用 `needs: check` + `if: always()` + 显式判 `needs.check.result`，作用是 `check` 失败时它仍会执行并 `exit 1`，把矩阵失败落成 required check 上一次明确的 failure。

**`always()` 是合并安全边界，不能省。** 没有它，`check` 失败时 `ci-ok` 会被 skip；而 GitHub 把 skipped 的 required check 计为 **success**、不挡合并——门禁会静默放行，而不是留下 pending。

run 级取消走的是另一条路径：`ci-ok` 排在两个 `check` 之后，取消时通常还没开始（已在跑的也会被标成 cancelled），不会执行 `exit 1`，该 SHA 上是 cancelled / 缺失而非 failure。取消同样**不产生 success**，合并仍被挡，但最新 SHA 被取消后要重跑。会让 check 停在 pending 的是 workflow 级 skip（`[skip ci]`、path/branch filter），同样只能等重跑解除。

### CI 并发只在 PR 上取消

`group: ci-${{ github.ref }}` 对 PR 是唯一的 merge ref，同一 PR 连续推送时取消旧 run，避免先发的旧结论后完成、把最新一次的读数盖掉。main 的 push 不取消：合并后那次运行的结果就是事实，取消它等于让 main 的状态无从判断。

### 报告入口结构化，安全报告走私密 advisory

`blank_issues_enabled: false` + 两个 Issue Form（缺陷、功能请求）。缺陷表单强制填插件版本、dsh 版本、安装方式、操作系统与复现步骤，把「贴一行报错让维护者猜」挡在入口。安全漏洞在 `SECURITY.md` 与 issue 模板 `config.yml` 的 contact_links 里都指向 private vulnerability reporting，不开公开 issue。

## 边界

- **required check 挡不住 PR 改自己的 CI**：`pull_request` 事件执行的是 PR merge ref 里的 workflow 文件，PR 可以把 `ci-ok` 改成 `exit 0`。这一层靠人工 review `.github/**` 的改动与 tag 保护，required check 只保证「没跑完不能合」，不保证「跑的是可信的检查」。
- **ruleset、fork 审批策略、private vulnerability reporting 是远端设置**，不在仓库里，`npm run check` 覆盖不到；换机器或重建仓库时要按 PR 描述重做一次。
- **Issue Form 的 labels 依赖仓库默认标签**（`bug` / `enhancement`）：标签改名或删除后表单会静默少打标签，不报错。
- **`SECURITY.md` 登记进了 `scripts/doc-budgets.json`**（387 / 410）：根目录 Markdown 全量枚举，漏登记 `npm run check` 直接红。

## 验证

- `npm run check` 全绿：82 篇笔记格式合规、14 篇文档工具名存在、14 篇 standing docs 都在天花板内（`SECURITY.md` 387 / 410）、语法 100 个文件、1063 用例通过（17 skip）、覆盖率门禁通过（55 个被单测加载，47 个行覆盖 100%）。
- 四个 YAML（`ci.yml` 与三个 issue 模板）本地解析通过。
- **workflow 语义与 Issue Form 字段没有本地用例覆盖**，只能靠 GitHub 上的真实 run 验。`ci-ok` 的聚合行为与 check 名已在 head `dcaa38d` 的 run `41780858764` 上验到：`check (24)` / `check (24.9.0)` / `ci-ok` 全 success。并发取消还没有真实触发过，取消后 `ci-ok` 的确切状态（cancelled 还是 expected）也未复现；Issue Form 的 schema 由 GitHub 上传时校验。这些不要当成已被本地用例覆盖。
