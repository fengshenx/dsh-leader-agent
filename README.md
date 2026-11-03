<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/fengshenx/dsh-leader-kit/main/docs/assets/readme/logo-en-dark.svg">
    <img src="https://raw.githubusercontent.com/fengshenx/dsh-leader-kit/main/docs/assets/readme/logo-en.svg" alt="dsh-leader-kit: a Leader fanning out to several workers, with a project board on the right" width="560">
  </picture>
</p>

<p align="center">
  <strong>English</strong> | <a href="README_ZH.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-leader-kit"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-leader-kit?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/fengshenx/dsh-leader-kit/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/fengshenx/dsh-leader-kit/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="dsh version" src="https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2-4b6fff?style=flat-square">
  <img alt="status" src="https://img.shields.io/badge/status-developer%20preview-7da1de?style=flat-square">
  <a href="https://www.npmjs.com/package/dsh-leader-kit"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-leader-kit?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/fengshenx/dsh-leader-kit/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/fengshenx/dsh-leader-kit?style=flat-square&color=4b6fff"></a>
</p>

# dsh-leader-kit

> One Leader drives the work and the review, so you can run ten features in parallel instead of babysitting each one.
>
> A leader / worker orchestration bundle for DeepSeek Harness (dsh). The Leader splits work, dispatches it, tracks every worker to completion, checks what comes back and runs review; workers do the work in the background, report back automatically, and every task fact lands on a board organized by project. Running one worktree per task is this repository's convention, not a requirement of the bundle.

## Highlights

1. **One Leader drives development and review** — You state the goal once. The Leader opens cards, dispatches workers, watches each one finish, verifies the deliverable and organizes review. Your attention goes back to "what do I want" instead of "which agent is stuck"; the target is ten features in flight at once.
2. **A right SidePanel board: see who is working at a glance** — One board per project. Each card carries its executor slot and a live status light, its note renders as Markdown, and its links are editable in place. Click a card for the spec (goal, scope, acceptance, links), click a slot to drill into that agent's session and keep talking; worker reports arrive as the worker speaking, also Markdown-rendered.
3. **Arrange your agents however you want** — Two files do the arranging. `LEADER.md` holds the Leader's prompt and this project's orchestration rules: boundaries, dispatch requirements, acceptance criteria. `SLOTS.md` gives each worker role its own rules (dev / review / …). Both are evaluated before every model request and appended only when their text changes, so editing a file changes behavior without recreating sessions.
4. **Many projects in parallel, one Leader each** — Adding a project binds a leader session to it, and the project tree lists the workers that Leader spawned; rows can be dragged to reorder, and deleting a project removes the workspace the plugin registered while keeping the folder and session records. Projects stay out of each other's way. Swap in a new Leader and the existing workers plus undelivered reports move over, so it can dispatch immediately.
5. **The `leader-mode` skill: an orchestration protocol for the Leader** — Not "you are a tech lead". Staged playbooks across discussion → design → implementation and delivery → review → merge, plus guidance on parallel collaboration and handoff.
6. **Read back what a worker did, without waking it** — `read_worker_session` reads a worker's session log directly and returns each turn's task, body, the tools it called and why anything failed. Read-only: it does not wake the worker and triggers no model call. The completion notice tells you what came out; this tells you how it got there, so debugging does not need another round.

## Install

### Desktop install (DeepSeek Harness Desktop)

Desktop uses its own profile (`$DSH_HOME/profiles/desktop`), separate from `web`.

**GUI install:** open **Plugins** in the left sidebar, click **Add plugin** in the top right, type `dsh-leader-kit` and click **Install**:

<img src="https://raw.githubusercontent.com/fengshenx/dsh-leader-kit/main/docs/assets/readme/desktop-add-plugin.png" alt="Add plugin wizard: enter dsh-leader-kit" width="880">

**CLI install:** the system `dsh` refuses to manage the desktop profile; use the CLI bundled with the desktop install:

```sh
# quit the app completely first (closing the window only hides it)
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add dsh-leader-kit
```

On Windows / Linux, use `runtime/cli/bin/dsh` inside the installation directory. The app reads the profile only at startup, and only one version can be mounted at a time. `DSH_HOME` must be absolute or start with `~/`. Sessions, projects, and cards are shared with `web`; plugin packages and activation are separate.

For development inside this repository, `npm run desktop` mounts the current worktree, rebuilds the bundle and launches the app; `-- --remove` unmounts it.

### Web install

Install from npm (package name `dsh-leader-kit`):

```sh
dsh plugin --profile web add dsh-leader-kit
dsh web
```

The profile must be named `web`; custom names are absent from `PROFILE_TEMPLATES`, so the install lacks the web-app bundle and the client half never loads. Requires dsh `>=0.2.1-rc.2 <0.3.0`.

For pinning a version, removing it, development installs, or trying it without a profile, see [Development](docs/development.md).

## Preview

<div align="center">
  <img src="https://raw.githubusercontent.com/fengshenx/dsh-leader-kit/main/docs/assets/readme/board.png" alt="dsh-leader-kit: the project tree on the left, the Leader's conversation in the middle, the delivery board on the right" width="1200">
</div>

Left: projects and the workers each Leader spawned. Center: the Leader's session — the task, the dispatch, the worker reporting back, the verdict. Right: the delivery board for the project, with one card per task and a slot chip per executor. You can see the agents that are working, click one to drill into its session and talk to it directly, without going through the Leader.

The screenshot shows a real working session.

## How it runs

```text
you ──────▶ Leader (the leader session, sole commander of the project)
             │  create_card      record what to build and how it is accepted
             │  spawn_worker     create the worker session, return immediately
             │  message_worker   deliver the first message — that is what starts work
             ▼
      worker ─ worker ─ worker        each runs in its own project directory
             │                        (one worktree each is the project convention, see Prerequisites)
             │  the turn end is settled by the runtime, workers submit nothing
             ▼
      Leader wakes up ──▶ board status lights update ──▶ open any worker and keep talking
```

Three mechanisms make this more than "a smarter prompt":

- **Identity decides the tool surface.** The Leader gets `spawn_worker` / `message_worker`; workers don't. The host trims the tool surface when a session is created — the model is not trusted to hold back.
- **Completion is settled by the runtime, which wakes the Leader.** When a worker's turn ends, the Leader receives a report (rendered as the worker speaking), with no polling from the Leader and no submit step from the worker.
- **Workers are persistent root sessions.** Several run at once, you can open any of them and keep the conversation going, and they cold-resume after a restart. The cost: the Leader cannot stop one, see [Current limitations](#current-limitations).

## Design trade-offs

- This project does not aim to rebuild dsh's own super agent. It solves one concrete problem: letting one person manage 20+ sessions.
- Today's agents are not reliable enough to run unattended, so the design assumes you can interrupt or push any worker at any point.
- The routing layer runs a full-size model. In practice, holding the global picture, it often connects several PRs in one thought and resolves what a single worker cannot see.
- Agent orchestration generalizes. A card describes the task itself, so it works outside coding and composes with any skill.
- Initialization is still manual: in your own project you write `LEADER.md` (the Leader's persona prompt and orchestration flow) and `SLOTS.md` (the role split and each role's persona prompt).
- The Leader leads and workers never talk to each other; the tool surface rules it out. Today's agents are trained for strict instruction-following, and one noisy message between two agents can derail the entire conversation.

## Five steps

1. **Add a project.** In the left sidebar's Projects section, click Add project and pick a directory. The project is created immediately and bound to a leader session; clicking the project row opens that Leader (a workspace the plugin registered and you deleted is recreated on the click, with the sessions put back). Selection comes in two layers: the whole row only lights up for the current Leader session, while opening a worker lights the folder at the row start and puts the row highlight on that worker's own session row. The slot at the row start is a folder icon by default: while the Leader is running it becomes a spinner (the Leader has no row of its own, so this holds whether the project is expanded or collapsed), and when the project is collapsed with a worker running under it, it becomes a spinner too — once expanded, each worker carries its own spinner.
2. **Load the protocol.** In the leader session, have the model load `leader-mode`. It reads `playbooks/program.md` first, then the playbook for the current stage.
3. **Dispatch.** `spawn_worker` requires `name` (a short role-task handle); `cardId` + `slot` optionally bind the card's executor slot in the same call. It returns a session id immediately and the worker has **not started yet**. Deliver the task body with `message_worker` (`sessionId` + `message`, optionally `rename`): the first message is what starts the turn, and a card-bound worker gets the card facts added to its request automatically, so you do not need to paste the spec. The worker's sandbox mode and approval policy are inherited from the Leader at dispatch time (an Auto Leader also passes on its review gate); the receipt states the permissions the worker actually runs with, and calls out full access by name. To see how it went about this turn — which tools it called, where it failed — use `read_worker_session` on it; that does not wake the worker.
4. **Record task facts.** `create_card` opens a card (`title` required), `update_card` edits one (content changes carry `expectedRevision` for optimistic concurrency; links can be replaced wholesale with `links` or merged by id with `addLinks`), `list_cards` reads them. Cards belong to a project and are numbered globally; edits across projects are refused. `list_cards` and `create_card` are the Leader's alone, and plain sessions get neither; `update_card` is shared with workers. A worker may only edit a card it is bound to, and only derived fields such as `links` — `title` / `spec` / `status` / `slots` belong to the Leader (the first two are the acceptance anchor and injected content, the last two decide who executes and whether the card counts as done).
5. **Watch the board.** The Board tab in the right panel pulls cards for the project of the current session. It opens by itself when the leader creates a card; click a card for details (links editable, the rest read-only), click a slot chip to open the executor's session.

## Orchestration lives in files

Three things, each covering one layer. All of them contribute prompt text only and grant no tool permissions:

| File / skill | For whom | What it holds |
|---|---|---|
| `LEADER.md` | The Leader of this project | How to command this project: boundaries, card and dispatch granularity, hard constraints every brief must carry, acceptance criteria. Injected into the leader session, with no binding step |
| `SLOTS.md` | Workers, by role | Per-role method and persona under `## <slot-name>` (`dev` / `review` / …). The card's `slots` field binds a slot to a session, and that session gets the section injected |
| `leader-mode` skill | The Leader's protocol | Staged playbooks for discussion → design → implementation and delivery → review → merge, plus parallel-collaboration and handoff guidance |

`LEADER.md` and `SLOTS.md` are evaluated before every model request and appended only when their text changes, so a change takes effect on the next request and nothing gets injected twice. The `leader-mode` skill takes a different path — the model loads it through the `skill` tool on demand, which is why the step above says load rather than configure. The target project's own `AGENTS.md` is read by the host's agent-instructions as a system-prompt section. Closing a card (`done` / `archived`) releases its executor: the slot binding and the card facts stop being injected together.

The plugin only reads `LEADER.md`. A `COORDINATOR.md` that merely points at it is a compatibility shim for external tools such as Telov that still look for the old file name; it is never injected, and you do not need it otherwise.

Slot names are ASCII identifiers (lowercase letters, digits, underscore, hyphen, up to 32 characters); display names come from the `slots:` frontmatter at the top of `SLOTS.md`. A project without `SLOTS.md` falls back to the default two roles `dev` / `review`.

The `init-leader-kit` skill handles project setup: it merges the repository's engineering conventions into a managed block of the target project's `AGENTS.md`, then writes `LEADER.md` (how the Leader drives this project) and `SLOTS.md` (executor roles) from the bundled skeletons. Re-running only replaces the managed block, and both manuals are read before editing. An empty directory gets the TODO skeleton plus the three questions still unanswered — project facts are never invented.

For the full interaction — slot frontmatter details, archiving, swapping the Leader, how board status lights are derived — see the [usage manual](docs/usage.md) (Chinese).

## Prerequisites: get multi-worktree parallelism working first

Running ten features in parallel requires real isolation between tasks: one worktree per task, one dsh instance per task, one data root per task, so tasks never overwrite each other's plugin version or compete for sessions and data. This repository's `scripts/worktree-*.mjs` and `scripts/dev.mjs` exist for exactly this ([Development](docs/development.md)); mechanisms and where each one lands are in [collaboration and documentation](docs/architecture.md#协作与文档机制) (Chinese).

## Current limitations

- **Background orchestration needs a long-lived host** (web / desktop / sdk). headless is a one-shot CLI: the session is destroyed when the turn ends, and nothing is left to receive completion reports.
- **The Leader cannot stop a worker.** Workers are ordinary root sessions, so the host's `list_agents` / `send_message` / `interrupt_agent` do not apply to them (`interrupt_agent` even returns a false success). A worker that goes off track has to be handled by a human in its own session. That is the price of persistence. You can read what it is doing (`read_worker_session`, read-only, no wake-up), but you cannot act for it or call it off.
- **Completion reports depend on the turn ending normally.** If the process dies before a worker finishes, that turn is never settled. After a restart, open the worker session and continue there.
- **The board only shows for project sessions.** The leader and that project's workers see it; an ordinary session in the same directory, or a retired leader, only gets a notice, and sessions outside any project get no board at all.
- **Card details only write links.** Links can be added, edited and removed in the detail panel; completing, pinning, renaming and deleting still belong to the Leader's card tools. Card numbers increase globally and are never reused or reclaimed across projects.
- **The project registry is only reachable from the left sidebar.** There are no project tools for the model; if the directory picker is unavailable you cannot create a project and need the web profile.
- **The project tree coexists with the official workspace tree.** Project sessions are hidden from the official tree at render time only; official counts and search still include them. The project directory itself also shows up as a workspace row there, so the same directory is reachable from both places.
- **The client is coupled to the host version.** Dialogs, menus and icons are copied from host sources, the Typert remote channel is a hand-written protocol shape, and the leader session layout depends on the host's session view service, so host upgrades require syncing this repository.

The full list and trade-offs (status-light sources, watermark collapsing, avatars, the archive entry point, DOM injection positioning and more) live in [known limitations and trade-offs](docs/limitations.md) (Chinese).

## Development

```sh
npm run worktree:spawn <task>     # create the worktree and feature branch
cd .worktrees/<task>
npm run dev                       # dsh instance mounting this worktree's plugin
npm run check                     # full gate
npm run e2e                       # browser e2e
```

Data roots, instance overrides, build constraints and the test policy are in [development](docs/development.md) (Chinese); the command index is in [AGENTS.md](AGENTS.md#常用命令) (Chinese). `npm start` runs the daily instance.

## Contributing

Read [AGENTS.md](AGENTS.md) first: worktree discipline, verification requirements, and documentation rules live there. The short path is `npm install` → `npm run check` → open a PR. Commit messages are in Chinese, and non-trivial changes ship an `.agents/notes/` decision note in the same PR.

## Docs

| Document | Contents |
|---|---|
| [AGENTS.md](AGENTS.md) | Repository rules and the task-routed reading index |
| [docs/getting-started.md](docs/getting-started.md) | Walkthrough (Chinese): prerequisites, adding a project and its Leader, the two project files, one card from creation to drill-down |
| [docs/usage.md](docs/usage.md) | Full interaction for dispatch, follow-ups, cards, board, project management, slots and manuals |
| [docs/architecture.md](docs/architecture.md) | Layers, runtime model, data flow, persistence layout, host-contract landing spots |
| [docs/limitations.md](docs/limitations.md) | Full known limitations and trade-offs |
| [docs/development.md](docs/development.md) | Dev environment, instances, build contract, test policy |
| [docs/capability-gaps.md](docs/capability-gaps.md) | Measured evidence for host capability boundaries (read before touching host-side code) |
| [docs/e2e-testing.md](docs/e2e-testing.md) | Browser e2e lane (commands, fixtures, mock conventions, assertion discipline) and manual evidence rules |
| [.agents/notes/](.agents/notes/) | Decision memory for non-trivial changes |
| [.agents/skills/leader-mode/](.agents/skills/leader-mode/) | Protocol layer: dispatch, handoff, event scheduling, card upkeep, acceptance |

## Credits

The design drew on **Cursor's Project implementation** and **PStack's orchestration mechanism**: treating a project as a first-class entity, aggregating sessions and deliverables per project, and the leader-dispatches / executor-reports / delivery-board line.

Thanks also to the **DeepSeek Harness team**: the host plugin contract, and the worktree, Agent Note, progressive-disclosure and documentation practices this repository mirrors directly.

## License

[MIT](LICENSE)
