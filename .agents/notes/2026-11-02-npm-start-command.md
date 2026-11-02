# npm start 起日常实例

## 背景

`npm run dev` 起的是隔离实例（数据根在 `.dev/home`、插件链到当前工作树），它解决多 worktree 并行，但不回答「本仓库这套代码装进日常 `~/.dsh` 之后是什么样」。此前日常实例的唯一入口是直接 `dsh web`，失败方式是「命令成功了但结果不对」：

- `lib/client.js` 不入库。新 clone 没构建过、或改过 `src/client/` 忘了重建时，`dsh web` 照常起来，只是右栏没有看板，宿主不报错。
- 日常 profile 没装本插件（或链接被 `dsh plugin` 换掉）时，起的实例与本仓库无关：没有看板、没有协调者工具，看起来像插件坏了。
- `dsh` 没装或不在 PATH（nvm 换 node 版本后 PATH 会重置）时，`spawnSync` 的原始报错是 `spawnSync dsh ENOENT`，不区分「没装」与「PATH 里没有」。

一条 `"start": "npm run build:client && dsh web"` 能消掉第一条（构建拼进命令），但后两条仍然沉默：用户看到的是「成功启动」或一句听不懂的系统报错。要给出可复制的修复命令，就得有一层脚本。

## 决策

### 语义：start 是日常实例，dev 是隔离实例

`npm start` 不派生 profile、不新建数据根：直接用 `~/.dsh`（`DSH_HOME` 可换）与 `profiles/web`，插件版本由那个 profile 的链接决定。两条命令的分工一句话能说清：start 验证「装进日常环境后什么样」，dev 验证「本目录这套代码」。

### 起之前按顺序检查，每项都给修复命令

1. `dsh` 可执行文件：用 `--version` 探测。ENOENT 时说明「没装或不在 PATH」，并提示 nvm 换版本会重置 PATH、`DSH_DSH` 可指定路径；非零退出码时把 stderr 打出来。
2. 日常 profile 的 `package.json`：不存在时给 `dsh plugin --profile web add <当前仓库>`。
3. bundles 里有 `@deepseek-ai/dsh-web-app`（复用 `assertWebBundle`）：缺它时 `dsh web` 不监听、不打印、也不报错，起一个「成功」的空进程最糟。
4. bundles 里有本插件（`assertLeaderKitBundle`，本 PR 新增）：缺它时实例不会加载本仓库。
5. `node_modules/dsh-leader-kit` 链接存在：声明了却没链接上说明链接被破坏。

`dsh --version` 顺带显示在启动横幅里，但**不校验 `engines.dsh` 范围**——npm 安装与宿主启动各自会拦，start 不重复实现 semver 比较。

### 构建产物只在链接指向当前目录时执行

`npm run build:client` 产出的是当前目录的 `lib/client.js`。profile 链接指向别处时（典型是从 worktree 里跑 start，链接指向主 checkout）跳过构建：否则产出的是没人加载的产物，还让人误以为本目录的改动已被验证。这种情况打印一行 warn，指向 `npm run dev`。

### 额外参数原样转给 dsh web

`npm start -- --no-open --port 3210` → `dsh web --no-open --port 3210`。start 不自己发明端口与打开浏览器的开关，宿主已有的选项直接透传。必须带 `--`：不带时 npm 会把 `--port` 当成自己的配置吃掉。

## 边界

- **start 不碰数据根**：只读 profile 的 `package.json` 与链接，不复制、不重建 profile。损坏修复仍交给 `dsh plugin`。
- **只在仓库里跑**：脚本用自身位置定位仓库根。从 npm 包目录跑没有意义（那里没有 `build:client` 需要的 `build/`）。
- **profile 名固定 `web`，不开放 `DSH_PROFILE`**：`dsh web` 读的就是 `profiles/web`，允许换名只会让脚本查一个 profile、实例读另一个。
- **worktree 里的 start 起的是主 checkout 的代码**：这是链接决定的，不是缺陷；脚本用 warn 说清，不替换链接（改日常 profile 的链接属于 `dsh plugin` 的职责）。
- **不校验 dsh 版本**：见上，由 npm 与宿主拦。
- **不做交互式修复**：任一检查失败即以 1 退出并打印命令，不替用户执行 `dsh plugin add`——那会改写日常 profile。

## 验证

`npm run check` 613 用例全绿。本 PR 新增 3 条 `dev-plan` 用例：日常 profile 已装本插件时放行、没装时拒绝并给出安装命令、没写 bundles 时拒绝。

双向验证：把 `assertLeaderKitBundle` 的判据替换成无条件 `return` → 「没装本插件时拒绝」「没写 bundles 时拒绝」两条变红（20/22 通过），还原后 22/22 绿。

真机读数（`dsh 0.2.1-rc.2`）：

- 正常路径：`DSH_HOME=/tmp/start-ok-home npm start -- --no-open --port 0`（profile 的插件链接指向本 worktree）先构建产物，横幅打印 `dsh dsh 0.2.1-rc.2`、数据根与插件路径，随后打印 `dsh web: http://127.0.0.1:…/?token=…` 并监听；`--no-open --port 0` 两项透传到位。
- 加载目录不同：`DSH_HOME=~/.dsh npm start -- --no-open`（链接指向主 checkout）打出 `[warn] 实例加载的是 …/dsh-leader-kit，不是当前目录 …/.worktrees/npm-start-script`，跳过构建（`lib/client.js` 的 mtime 不变）。
- 四条失败路径各自以 1 退出并给出可复制的修复命令：`DSH_DSH=no-such-dsh`（提示 PATH 与 nvm）、数据根没有 profile、profile 缺本插件、profile 声明了但没有 `node_modules/dsh-leader-kit` 链接。
