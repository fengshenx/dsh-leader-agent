# Agent Note: 对外开放 issue/PR 的三道入口防线

Status: implemented

## Problem

仓库此前是单人闭环：PR 都由维护者自己开，ruleset 只有禁删、禁强推、强制走 PR 三条，没有 required status checks——CI 绿不绿不影响合并。开放外部 issue 与 PR 后威胁模型变了：PR 可以改自己的 workflow 文件、可以从 fork 带来未审阅的提交、issue 入口会迎来大量缺少版本与复现步骤的报告。

## Decision

- **required check 只认聚合 job `ci-ok`**：矩阵按 Node 版本展开成多个 check 名，登记矩阵名意味着改 matrix 的当天所有 PR 永远等一个不会再出现的 check；`ci-ok` 用 `needs: check` + `if: always()` + 显式判 `needs.check.result`，把矩阵失败落成 required check 上一次明确的 failure。
- **`always()` 是合并安全边界，不能省**：没有它，`check` 失败时 `ci-ok` 被 skip，而 GitHub 把 skipped 的 required check 计为 **success**、不挡合并——门禁会静默放行。
- **取消语义只有两条可执行结论**：取消不会把失败变成 success；`ci-ok` 为 success 的唯一前提是 `check` 已 success。run 级取消是否重新求值 `if` 取决于取消到达时 `ci-ok` 有没有开始；workflow 级 skip（`[skip ci]`、path/branch filter）让该 SHA 停在 expected，且没有 run 可以 Re-run，要推一个不带 skip 标记的新 commit。
- **CI 并发只在 PR 上取消**：同一 PR 连续推送时取消旧 run，避免先发的旧结论后完成、把最新读数盖掉；main 的 push 不取消——合并后那次运行的结果就是事实。
- **报告入口结构化，安全报告走私密 advisory**：关闭空 issue、用两个 Issue Form（缺陷、功能请求），缺陷表单强制填插件版本、dsh 版本、安装方式、操作系统与复现步骤，把「贴一行报错让人猜」挡在入口；安全漏洞在 `SECURITY.md` 与模板 `contact_links` 里都指向 private vulnerability reporting，不开公开 issue。

## Alternatives considered

- **required check 直接登记矩阵 job 名**：改 matrix 的当天所有 PR 会永远等一个不再出现的 check；只认聚合 `ci-ok`。
- **`ci-ok` 不写 `always()`**：`check` 失败时聚合 job 被 skip，而 GitHub 把 skipped 的 required check 计为 success；门禁会静默放行。
- **main 的 push 也取消旧 run**：合并后那次运行的结果就是事实；只在 PR 上取消。
- **继续用自由文本 issue 模板**：会迎来大量缺版本与复现步骤的报告；改两个结构化 Issue Form。
- **安全漏洞走公开 issue**：披露风险；`SECURITY.md` 与模板都指向私密 advisory。

## Consequences

- required check 挡不住 PR 改自己的 CI：`pull_request` 执行的是 PR merge ref 里的 workflow 文件，PR 可以把 `ci-ok` 改成 `exit 0`；这一层靠人工 review `.github/**` 与 tag 保护，required check 只保证「没跑完不能合」，不保证「跑的是可信的检查」。
- ruleset、fork 审批策略与 private vulnerability reporting 是远端设置，仓库里没有、`npm run check` 覆盖不到，换机器或重建仓库时要重做一次。
- Issue Form 的 labels 依赖仓库默认标签（`bug` / `enhancement`），标签改名或删除后表单静默少打标签、不报错。
- `SECURITY.md` 登记进文档预算清单：根目录 Markdown 全量枚举，漏登记 `npm run check` 直接红。

收益：外部 PR 在 CI 未真正通过前合不进去，issue 入口能拿到可复现的信息，安全报告不走公开通道。

## Testing

`npm run check` 全绿、四个 YAML 本地解析通过。workflow 语义与 Issue Form 字段没有本地用例，只由真实 run 验到「矩阵全绿时 `ci-ok` 通过、check 名精确匹配」两条；矩阵失败、取消聚合与远端 required check 实际拦截都未触发，不能当成已被本地用例覆盖。
