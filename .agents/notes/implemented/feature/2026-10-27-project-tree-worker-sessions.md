# 项目树只列 worker 会话

> **2026-10-29 取代**：worker 身份判据已从「会话头 `origin: 'subagent'`」换成「登记表说它是本 bundle 派出的 worker」——worker 改成了普通根会话，会话头没有这个标记；官方树也因此不再自动滤掉 worker，排除集要显式包含它们。本文件保留当时的选择理由，现行机制见 [worker 常驻化与交作业](../architecture/2026-10-29-worker-as-root-session.md)。
>
> **2026-11-03 起项目树也列退役 leader**：项目不再注册工作区（见[解耦](../architecture/2026-11-03-project-workspace-decoupled.md)），退役 leader 与 worker 同列。本文的 `origin: 'subagent'` 判据与「取消工作区隐藏」两节已失效。

## 背景

需求是「新建项目后直接展示，不要注册流程」与「项目下只展示 worker 会话」。原先要先选目录、再起名、点注册；项目树按目录列出该目录下的**所有**会话，插件注册的项目工作区又被整棵藏起来。

## 决策

- **归组判据看登记表**：项目树列登记为本 bundle worker 的会话，以及该项目的退役 leader；现任 leader 只在项目行上，用户在项目目录里手动开的会话不属于「这个项目有哪些 worker」。判据见 [worker 常驻化与交作业](../architecture/2026-10-29-worker-as-root-session.md)，退役 leader 的呈现见 [退役协调者会话留在项目下](2026-10-30-retired-coordinator-sessions.md)。
- **工作区行始终可见**：项目不再注册工作区，用户手动开的会话走官方工作区树；项目会话仍由渲染层排除，不在官方树里重复出现（见[项目与 dsh 工作区解耦](../architecture/2026-11-03-project-workspace-decoupled.md)）。
- **加项目直接建好，失败要有出口**：选完目录即建项目并出现在列表里，名字默认取目录名，要改用行上的「重命名」；目录选择器不可用时提示改用终端里的 `add_project`。两个例外必须有出路：目录名当不了项目名（根目录、超长）时退回可改名的输入框——直接提交只会换回一条没有出口的报错；同名目录（如 `/work/a/repo` 与 `/work/b/repo`）落盘时自动加序号，查重与写入在同一条串行链里完成。
- **改名撞名报错，不偷偷加序号**：建项的自动避让只建立了「名字唯一」的一半，改名同样能撞上；他明明打了一个名字，被改成「X-2」比看到「已被占用」更意外。
- **与项目看板的分工**：树列「这个项目有哪些执行会话」，看板列「这个项目有哪些任务卡」，因此树认 worker 登记表与退役 leader 名单，看板认卡片的 `projectId`。用户在项目目录里手动开的会话不在树里，但它建的卡是这个项目的任务，出现在看板里（见[看板按项目组织](2026-10-27-project-bound-board.md)）。

## 边界

- 排除集包含现任 leader、退役 leader 与 worker 会话（项目树自己列后两类）；用户手动开的会话留在官方工作区树里。
- 子目录里的 worker 不算项目下的 worker（realpath 精确相等）。
- `workspaceId` 已随工作区解耦删除。

## 验证

`tests/project-panel.test.js`、`tests/projects-store.test.js`、`tests/project-session-index.test.js` 钉住项目名判定与归组；双向：撤掉 `uniqueProjectName` 的查重或改名时的查重，对应用例变红。
