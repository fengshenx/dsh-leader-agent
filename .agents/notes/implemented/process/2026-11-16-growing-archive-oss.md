# Agent Note: 增长资产用 growing 索引与 OSS 媒体库

Status: implemented

## Problem

宣传片和增长素材此前只存在于本地 `.dev/`，无法作为项目资产追溯；直接入库又会让视频、音频、standalone HTML 把代码仓库撑大。Release 语义上绑定版本，不适合持续增长的内容；LFS 虽能放二进制，但仍留在主仓历史里，clone 和带宽都要为媒体付费。

## Decision

- **仓库只存索引与源文件**：`growing/<YYYY-MM-DD-slug>/` 放 README、文案、分镜、timeline、可编辑 HTML、小素材、`media.json` 和 ≤200 KB 预览图。
- **媒体走 OSS**：专用 bucket `dsh-agent-leader`（`oss-cn-beijing`，public-read），key 固定为 `growing/<case>/<kind>/<file>`；key 不可覆盖，重做换新 key。上传脚本的 `stat → cp` 不是原子操作，所以**禁止并发上传同一 key**（不加锁，靠纪律）。
- **每个案例有 `media.json`**：记录 URL、bytes、sha256、contentType；Git 里能核验媒体身份，但不需要保存字节。共用字段在顶层，资产按 `versions[]` 分组，`fps`/`durationSeconds` 写在组内——v1 30fps、v2 60fps，放顶层会被读成同一份。
- **规则单一归属**：`growing/AGENTS.md` 是唯一 owner（Git 边界、bucket、key 口径、公开清单、上传方法）；根 `AGENTS.md` 只留一行入口，`growing/README.md` 只做索引，案例文档只记本次取舍。
- **文档预算覆盖增长目录**：`growing/**/*.md` 递归纳入 `verify-doc-budgets.mjs` 的枚举，漏登记即红——否则案例文档会成为绕过整套预算的旁路。
- **不使用 LFS、不使用 Release**：媒体只走 OSS；Release 只给真正的软件版本。

## Consequences

- 代码仓库保持文本级体量；增长案例可 diff、可复制、可追溯。
- bucket 是公共读，只允许放可公开的增长素材；任何密钥、用户数据、未脱敏截图都不能上传。
- 媒体可用性依赖 bucket 与 URL；迁移 bucket 时要同步更新 `media.json`，旧 key 保留或显式迁移。
- OSS 标准域名对 HTML 与封面 PNG 都强制下载（`Content-Disposition: attachment`），video/audio 不会；要在线渲染只能绑自定义域名。
- public-read 的风险在内容不在 ACL：上传前按 `growing/AGENTS.md` 的检查清单逐项核对，上传后撤不回。
- 收益：增长资产的“字节”和“决策/源文件”分开存放，仓库不再为每次视频迭代变胖。

## Alternatives considered

- **全部提交到 Git**：几百 MB 媒体会让 clone 变慢，且每次重渲染都新增一份历史；不适合长期沉淀。
- **Git LFS**：Free 10 GB 存储 + 10 GB/月带宽，仍要求 clone 拉媒体，公开仓库的下载还算 owner 带宽；对本项目的用法不如 OSS 直接。
- **GitHub Releases 当资产桶**：语义绑定 tag/版本，非版本内容会变成伪装成版本的归档；不采用。
- **独立 media 仓库**：能隔离代码，但多一个仓库和同步成本；`growing/` + OSS 已满足同一入口。

## Testing

`npm run check`（文档预算 20 篇，含 `growing/` 5 篇；删掉一条 growing 登记后门禁变红，还原后全绿）；`curl -I` 逐个验证 `media.json` 的 URL 为 200、Content-Type 与 `Content-Disposition` 实测一致；源 HTML 在 1080×1920/390×844 打开无破图；上传脚本对已存在 key 返回非零且不覆盖。
