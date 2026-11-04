---
slots:
  dev:
    label: 开发
  review:
    label: 审核
---

# 角色槽位

本文件由 dsh-leader-agent 解析：顶部 YAML frontmatter 的 `slots:` 声明每个槽位的显示名，正文按 `## <槽位名>` 分节；leader 用卡片的 `slots` 字段把槽位绑到执行会话，被绑会话每轮 turn 注入对应正文。槽位名是 ASCII 机器标识（小写字母、数字、下划线、连字符，最长 32 字符），`label` 可用中文。槽位只描述工作方法与人设，不授予工具权限。

> 这是骨架：把每节正文换成这个项目对这类角色的要求。需要单独的讨论角色就自己加一节 `## discuss` 并在 frontmatter 补上声明；不需要的槽位整节删掉，frontmatter 里对应声明一起删。

## dev

TODO：实现者开工前要读什么、改动范围与工作区约定、提交前要跑的验证。

## review

TODO：审查者的判据与严重度分级、结论要带什么证据、发现问题怎么退回。
