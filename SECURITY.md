# 安全策略

## 支持的版本

只修 `0.3.x` 及之后的版本。更早的版本请先升级再报告：`engines.dsh` 与宿主版本绑定，旧版本往往装不进当前的 dsh，修了也发不出去。

## 报告漏洞

**不要开公开 issue。** 用 Security 标签页的 [Report a vulnerability](https://github.com/fengshenx/dsh-leader-agent/security/advisories/new) 提交私密报告。报告只有维护者可见，修复与披露都在同一条 advisory 里完成。

报告请附：插件版本、dsh 版本、复现步骤，以及影响面（能读到什么、能执行什么）。能给出最小复现最好。

## 在范围内

本插件以宿主进程权限运行，客户端半边直接使用宿主模块表，以下都算安全边界：

- `src/host/` 里读写文件、执行命令、按项目路径访问数据的逻辑
- `src/client/` 对会话内容、项目与卡片数据的渲染（会话标题与消息来自外部输入）
- `scripts/github-app-*.mjs` 的凭据读取与 JWT 签名
- 发布链路：`.github/workflows/publish.yml`、打包清单与 `prepublishOnly`

## 不在范围内

- 宿主（`@deepseek-ai/dsh-*`）自身的漏洞，报给上游
- 安装来路不明的插件后发生的事
- 报告里粘贴真实 token、私钥或他人的会话内容

## 披露

修复版本发布后在同一 advisory 里公开细节；补丁版本可用之前不公开。没有固定 SLA，但会在确认后尽快给回复。
