# Agent Note: 桌面版在 worktree 里改用派生数据根，不动别人的 desktop profile

Status: implemented

## Problem

桌面应用的 profile 固定为 `$DSH_HOME/profiles/desktop`，只有一份。主 checkout 装过一次之后，在 worktree 里跑 `npm run desktop` 会被归属守卫拒绝，想验证本分支只能先卸掉主 checkout 再装回来——几个 worktree 并行时会互相顶掉，主 checkout 的桌面版也会在下次启动时变成某个分支的代码。而「不覆盖别人的安装」是本脚本的既有语义，不能为跑通拆掉。

## Decision

> **已被 [影子数据根](2026-11-24-desktop-shadow-home.md) 部分取代**：现在由命令决定模式
>（`npm run desktop` = dev 派生根，`npm run desktop:prod` = 正式数据影子根），不再按主
> checkout / worktree 区分；派生根的目录与派生机制仍按本文。

- **按当前目录的身份选数据根，`planDesktopHome` 是唯一判定点**：worktree 内（`.git` 是文件）派生 `<工作树>/.dev/desktop-home`——profile 从日常 `profiles/desktop` 派生（`deriveProfilePackage` 照抄依赖与 bundle，只把本插件换成工作树链接），`node_modules` 逐条链回源 profile，日常 profile 一个字节都不动；主 checkout 内（`.git` 是目录）照旧写日常 profile；显式 `DSH_HOME` 两条都不走，就写那一份根。
- **派生与依赖链接直接调 `dev-instance.mjs` 的 `prepareProfileDir`**：与 `npm run dev`、e2e 共用同一份实现，三处组合一旦漂移，e2e 测到的就不是用户拿到的实例。
- **凭据跟着搬**：派生数据根独立，`.credentials.yaml` 也要有 `refs`，否则一进界面没有 API key；`inheritCredentialRefs` 与 `dev` 共用一份实现，取舍见 [开发实例从源 HOME 继承凭据 refs](2026-11-02-dev-instance-inherits-credential-refs.md)。
- **派生根叫 `.dev/desktop-home` 而不是 `.dev/home`**：与 `npm run dev` 同时开着时，共用一份数据根会让两边往同一批会话、项目、卡片里写。
- **探活放在派生之前**：应用在跑时连派生根都不碰，免得改到正在被读的 profile。
- **`--remove` 反方向但同样只算路径、不派生**：派生有副作用（建目录、重写 manifest、复制日常凭据），而「这根上没挂过」本来就该是空操作；摘除只用 `derivedDesktopPaths` 算出目标根，判的是那条根上有没有挂载——没建过就打印「没有可摘的挂载」返回，不创建目录、不读日常凭据。它也早于「日常 profile 是否存在」的检查，日常那份被删掉时派生根里的挂载照样摘得掉。

## Alternatives considered

- **worktree 里直接拒绝桌面版**：要验证分支只能先卸掉主 checkout，几个 worktree 会互相顶掉；按当前目录派生数据根。
- **派生根复用 `.dev/home`**：与 `npm run dev` 同时开时会往同一批会话/项目/卡片写；改用 `.dev/desktop-home`。
- **在 desktop 脚本里重写一份 profile 派生**：会与 dev、e2e 漂移；直接调 `prepareProfileDir` 与 `inheritCredentialRefs`。
- **`--remove` 也先派生**：建目录、重写 manifest、复制凭据都有副作用；摘除只算路径，没挂过就是空操作。
- **用 `--user-data-dir` 绕单实例锁**：会把账号与更新状态一起隔离，代价更大；探到运行态直接拒绝。

## Consequences

- 数据是两套：派生根的会话、项目、卡片与日常实例不通；这是隔离的代价，要日常那套就在主 checkout 跑。
- 同一时刻只能有一个桌面实例：Electron 的 `requestSingleInstanceLock` 按共享的 userData 判定，日常实例在跑时派生根起的进程会自己退出；脚本探到运行态直接拒绝，不为隔离实例绕单实例锁（`--user-data-dir` 会把账号与更新状态一起隔离，代价更大）。
- 源 profile 必须存在：派生根从日常 profile 抄依赖，日常 profile 不存在时报「先打开一次桌面应用」，不新建一个空 profile 去派生出没有依赖的实例。
- worktree 判定看 `.git` 是文件还是目录、不起 git 子进程；把仓库 clone 到别处（`.git` 是目录）仍算主 checkout 语义——那台机器上它就是日常那份。
- 派生根在 `.dev/` 下、已被 gitignore，删掉即重置，`worktree:prune` 随 `.dev` 一起挪走。

收益：worktree 里的桌面版有自己的数据根与凭据，主 checkout 的桌面 profile 一个字节不动，摘除也不留副作用。

## Testing

`tests/desktop-plan.test.js` 覆盖两态判定与接线顺序（探活早于派生、摘除不派生、凭据 refs 搬入派生根）；`tests/desktop-remove.integration.test.js` 用真实脚本与临时 HOME 钉住摘除对称性，撤销「摘除不派生」即变红。
