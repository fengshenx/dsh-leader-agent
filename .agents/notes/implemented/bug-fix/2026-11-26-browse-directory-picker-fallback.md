# Agent Note: browse 宿主上加项目退回应用内目录浏览

Status: implemented

## Problem

宿主在 linux（`PATH` 上没有 zenity/kdialog）、没有 display、SSH 启动、非 loopback bind 或放行远程 authority 时会组合 `browse` 目录选择器。`uiWorkspace.pickDirectory()` 只服务 native，调用以 `directory-picker/unavailable` 拒绝，界面上就是「建项目失败: directory picker failed: … the composed picker serves "browse"」。官方 UI 能加工作区，因为 browse 客户端半边自己渲染目录树；本仓的「加项目」没有降级路径，WSL / 远程 web 实例上建不了项目。

## Decision

**native 被拒后用同一 `uiWorkspace` 的 browse 原语自己渲染目录浏览。** 打开流程照常先调 `pickDirectory()`（native 宿主体验不变），被拒时用 `listDirectory()` 的成败判能力（探测最多等 5 秒，网络盘 home 卡住不会让「加项目」一直 busy）：成功即 browse 宿主，把预取的主目录列表交给弹层；失败则把原始 pick 错误抛回用户。弹层用 `listDirectory` / `createDirectory` 两个原语：面包屑从主目录起（与宿主一致）、「上一级」（完整 ancestry 里取父级，能走到 home 之外）、隐藏目录开关、新建文件夹；扫描或新建期间冻结面包屑、条目与「上一级」，空名不发请求，重名/非法字符由宿主拒绝；选中当前层后交给与 native 共用的 `adoptDirectory`（默认名、改名兜底、建项、展开列表）。

**不预判、不缓存能力**：客户端拿不到 capability kind（见 capability-gaps 第 47 条），预判只能靠探测；每次加项目最多多一次被拒的 RPC，换掉一份会随宿主切换后端而失真的缓存。

## Alternatives considered

- **用官方 `workspace.picker` Factory**：它会顺手注册一个 dsh 工作区，而项目与工作区是有意解耦的（[2026-11-03 笔记](../architecture/2026-11-03-project-workspace-decoupled.md)），不能用。
- **等宿主暴露 `capability()`**：宿主没有这个公开面；先把用户可用性修好，探测留到宿主提供只读能力再删。
- **按错误文案识别 browse**：`directory picker failed: … serves "browse"` 是宿主英文串，措辞一改就失配；用 `listDirectory` 成败是行为判据，不绑文案。
- **只给一个路径输入框**：实现更小，但用户拿不到目录结构、也没法建目录；WSL 的 `/mnt/c/...` 手打路径体验不可接受。

## Consequences

- native 宿主行为不变；browse 宿主多出一个应用内弹层（插件自己的样式与 8 语言文案）。
- 弹层只列目录、不列文件；隐藏目录默认折叠，可切换。
- native 的真实失败且 list 也失败时仍显示原来的 pick 错误，不把「native 坏了」伪装成 browse。
- 收益：SSH / headless Linux / WSL 等 browse 宿主上「加项目」重新可用，不再要求换机器或装 zenity。

## Testing

`tests/e2e/project-browse-picker.e2e.js` 用 `SSH_CONNECTION` 把真实宿主钉到 browse：点加项目 → 上一级到根 → 进 `/tmp` 目标目录 → 选中，断言项目行与 `projects.json`。双向验证：撤掉 `startAdd` 的 browse 回退，场景在「弹出应用内浏览」超时变红；还原后约 6 秒绿。纯逻辑（面包屑、上一级、隐藏过滤、失败文案）以及 probe 的 native 拒绝/取消、新建文件夹成功/重名/非法字符（fake workspace）在 `tests/directory-browse.test.js`。`engines.dsh` 下限核对：`listDirectory` / `createDirectory` 在 `0.2.1-rc.2` 的 `UiWorkspace` 已存在（npm 包 `lib/types/client/navigation.d.ts`）。
