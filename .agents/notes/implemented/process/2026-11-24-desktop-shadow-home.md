# Agent Note: 桌面开发用影子数据根，线上 profile 不动也不需要还原

Status: implemented

## Problem

宿主把桌面 profile 写死在 `$DSH_HOME/profiles/desktop`（`resolveDesktopPaths`），CLI 还把
`desktop` 这个名字判为 Electron 独占；没有 profile 开关。线上插件装在同一个 profile 里
时，`npm run desktop` 要么覆盖线上安装，要么临时换名——换名会留下「还原进程被杀或断电
后，线上 profile 停在开发版」的窗口，直接启动就不再是线上版。需求是：主 checkout 里跑
本仓代码，会话、项目、卡片与线上版共用，线上 profile 一个字节不动，直接启动永远线上。

## Decision

- 给应用一个**影子 `DSH_HOME`**：prod 是 `<repo>/.dev/desktop-prod-home`；dev 仍用
  `<repo>/.dev/desktop-home`。两个根必须不同：影子根把数据目录链回日常根，dev 复用
  同一根时，dev 的会话/项目/卡片会顺着链接写进正式数据。影子根里的 `profiles/desktop`
  从日常 profile 派生（依赖与 bundle 照抄、本插件指工作树），其余顶层项链回日常根：
  目录用符号链接（Windows junction），只读小文件复制。
- 凭据不靠链接：开发 profile 的 `cordis.patch.yml` 把 `credentials` 行的 `path` 指回
  `<日常根>/.credentials.yaml`。`dsh-credentials-local` 用 `writeFileAtomic`，链接会被
  rename 替换成副本，必须在配置层指路径。
- 不做换名、没有标记、没有后台还原进程：应用被 kill、崩溃、断电，线上 profile 与日常
  数据都没有需要还原的状态；下次 `npm run desktop` 重建影子根即可。
- 模式由**命令**决定：`npm run desktop:prod`（`--prod`）→ 影子根（共用日常数据）；
  `npm run desktop` → 派生根（dev，数据独立，适合并行验证分支）。不再按主 checkout /
  worktree 或环境变量猜意图。
- 宿主将来新增顶层数据域时，它只会落在影子里；下次启动（或 `--remove`）把不在清单里的
  实体项搬回日常根，已有同名实体则挪到旁边并告警，不删数据。清单里的 known 项若被人
  换成实体目录（`sessions` 链接变成目录），也按同样的「搬走/挪到旁边」处理，不跟随
  `rmSync` 删除。
- `--remove` 只删影子根；旧版永久挂在线上 profile 的 `link:` 要
  `--remove --remove-mount` 显式摘除（会改线上 profile），默认输出只提示不摘。
- 顶层文件照清单复制，其中 `.env` 可能带密钥，影子副本权限收到 600；这是「文件复制」
  而非「凭据链接」的代价，凭据本身仍用 `credentials.path` 指回日常文件。
- 源根与影子根 realpath 相同时拒绝同步，避免把用户显式指定的日常根先挪走再改写。

## Alternatives considered

- **临时换名**：数据零分叉，但还原依赖后台进程；进程被杀或断电后线上 profile 停在开发
  版。可靠性不够，已废弃。
- **宿主加 profile 参数**：最干净，但当前宿主路径与名字都写死，要宿主先发版；本仓不能
  改宿主。影子根本质是这一能力的仓内替代。
- **独立数据根（worktree 那套）**：不碰线上，但会话、项目、卡片是另一套，不满足共用。
- **凭据文件也链过去**：原子写用 rename 替换链接，开发实例写到副本，两边分叉。

## Consequences

- 线上 `~/.dsh/profiles/desktop` 在启动路径前后完全一致；直接启动始终是线上版。
- `npm run desktop` 不会读日常会话/卡片；要共用就跑 `npm run desktop:prod`。
- 开发会话写真实会话/项目/卡片：存储格式的降级兼容由开发版负责。
- 宿主新增的顶层数据域在下一次运行前只存在影子里（不丢，搬回有延迟）；同名冲突挪到
  `.dev/desktop-home-leftover-*` 并告警。`--remove --remove-mount` 是唯一会改线上
  profile 的路径。
- 会话期间在插件管理里改的东西落在影子 profile，重建时消失。
- 同一时刻仍只有一个桌面实例；直接启动会激活正在运行的开发实例。
- 收益：`desktop:prod` 时本地代码与日常数据共用，线上 profile 零改动，不需要卸载，也
  没有还原状态。

## Testing

`tests/desktop-shadow.test.js` 覆盖链接/复制/凭据指向/新数据域搬回/known 项被换成实体
目录时挪到旁边/源根与影子根相同拒绝/`.env` 副本 600；`tests/desktop-remove.integration.test.js`
用真实脚本验证：整棵日常根（sessions/storages/cards/credentials 等）树级指纹不变、
dev 与 prod 启动分别落不同根、prod 建影子后跑 dev 日常不变、假 `.app` 启动路径、默认
`--remove` 不摘线上旧版挂载而 `--remove-mount` 才摘。另用安装版桌面 CLI 把影子 profile
以 `probe` 名 `--dump-config`，确认 `credentials` 行落在 `~/.dsh/.credentials.yaml`、
`dsh-leader-agent` 解析到工作树。
