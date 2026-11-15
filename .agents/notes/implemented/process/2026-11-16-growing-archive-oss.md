# Agent Note: 增长资产用 growing 索引与 OSS 媒体库

Status: implemented

## Problem

宣传片和增长素材此前只存在于本地 `.dev/`，无法作为项目资产追溯；直接入库又会让视频、音频、standalone HTML 把代码仓库撑大。Release 语义上绑定版本，不适合持续增长的内容；LFS 虽能放二进制，但仍留在主仓历史里，clone 和带宽都要为媒体付费。

## Decision

- **仓库只存索引与源文件**：`growing/<YYYY-MM-DD-slug>/` 放 README、文案、分镜、timeline、可编辑 HTML、小素材、`media.json` 和 ≤200 KB 预览图。
- **媒体走 OSS**：专用 bucket `dsh-agent-leader`（`oss-cn-beijing`，public-read），key 固定为 `growing/<case>/<kind>/<file>`；key 不可覆盖，重做换新 key。
- **每个案例有 `media.json`**：记录 URL、bytes、sha256、contentType；Git 里能核验媒体身份，但不需要保存字节。
- **两层 AGENTS**：根 `AGENTS.md` 放硬规则（会被动注入），`growing/AGENTS.md` 放进目录工作时的详细清单。
- **不使用 LFS、不使用 Release**：媒体只走 OSS；Release 只给真正的软件版本。

## Consequences

- 代码仓库保持文本级体量；增长案例可 diff、可复制、可追溯。
- bucket 是公共读，只允许放可公开的增长素材；任何密钥、用户数据、未脱敏截图都不能上传。
- 媒体可用性依赖 bucket 与 URL；迁移 bucket 时要同步更新 `media.json`，旧 key 保留或显式迁移。
- 收益：增长资产的“字节”和“决策/源文件”分开存放，仓库不再为每次视频迭代变胖。

## Alternatives considered

- **全部提交到 Git**：几百 MB 媒体会让 clone 变慢，且每次重渲染都新增一份历史；不适合长期沉淀。
- **Git LFS**：Free 10 GB 存储 + 10 GB/月带宽，仍要求 clone 拉媒体，公开仓库的下载还算 owner 带宽；对本项目的用法不如 OSS 直接。
- **GitHub Releases 当资产桶**：语义绑定 tag/版本，非版本内容会变成伪装成版本的归档；不采用。
- **独立 media 仓库**：能隔离代码，但多一个仓库和同步成本；`growing/` + OSS 已满足同一入口。

## Testing

`npm run check`；`curl -I` 逐个验证 `media.json` 的 URL 为 200 且 Content-Type 正确；源 HTML 在 1080×1920/390×844 打开无破图；上传脚本对已存在 key 返回非零且不覆盖。
