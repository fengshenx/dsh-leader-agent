# Agent Note: leader 工具面补上 wait_agent

Status: implemented

## Problem

leader 会话误调 `wait_agent` 等 worker 完成，结果阻塞到超时。agent-team 禁令已点名 `wait_agent`，`leader-mode` 本次同步补上；根因仍是工具面漏项——`HOST_SUBAGENT_TOOLS` 只列了 `list_agents` / `send_message` / `interrupt_agent` 三件，而 0.2.2 的 `tool-subagent-control` 增加了第四件 `wait_agent`。

`wait_agent` 的描述是「等下一步输入」，不提 teammate，模型很容易把它当成「等 worker 完成」。但 worker 是普通根会话，完成通知本来就会把 leader 从回合外唤醒；这个工具只会在 leader 回合内阻塞，等到超时或一条与 worker 无关的输入。

## Decision

把 `wait_agent` 当作 `tool-subagent-control` 的第四件工具，加进 `HOST_SUBAGENT_TOOLS`，随 `LEADER_DENY_TOOLS` 一起对 leader 摘掉。普通会话保留：它们可能真的在用官方 subagent 的等待语义。

agent-team 不受影响：它是另一套编排，宿主默认关闭，团队模式开不开由人决定；本 PR 不改它的服务、模式或团队任务工具。`wait_agent` 在 agent-team 的禁令名单里仍然出现，但 leader 的工具面已经从源头拿掉它。

## Alternatives considered

- **只改提示词**：agent-team 禁令已点名 `wait_agent`，仍被调用；工具面漏项不补，文案只是建议。
- **把 `team_task_*` 一起 deny、并强制关闭 leader 的 team 模式**：宿主默认就不开团队模式，强制关闭是对会话状态的额外写入；agent-team 要保留给其他会话，不做。
- **连 `subagent` / `subagent_fork` 一起 deny**：leader 只用它们做只读探索，不拿它们当 worker；保留通用能力，只摘掉对 worker 无效、且会诱导阻塞的入口。

## Consequences

- leader 的工具面不再出现 `wait_agent`；worker 会话结束仍按既有 `dispatch` 路径唤醒 leader。
- `wait_agent` 在 `engines.dsh` 下限（0.2.1-rc.2）的 `tool-subagent-control` 里不存在，`applyToolGate` 的逐件重试会跳过它，不影响旧版本启动。
- 收益：模型不再有「等 worker」的阻塞入口，leader 的动作面回到 `spawn_worker` / `message_worker` / `read_worker_session`。

## Testing

`tests/tool-gate.test.js` 断言 `HOST_SUBAGENT_TOOLS` 含 `wait_agent`、leader 的 deny 列表包含它，并覆盖 rc.2 的「三件在、`wait_agent` 缺」逐件重试路径；普通会话与 worker 另有字面量反向断言。双向验证：从 `HOST_SUBAGENT_TOOLS` 删掉 `wait_agent`，leader 与 mixed 用例变红；把 `wait_agent` 塞进 `PLAIN_SESSION_DENY_TOOLS`，反向断言变红。
