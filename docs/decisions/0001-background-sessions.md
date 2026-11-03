# ADR 0001：使用后台会话 + 看板，而不是 tmux 分屏 / Agent Teams

- 状态：已采纳
- 日期：2026-11-03
- 取代：早期计划中的 “WSL + tmux 分屏 + Agent Teams”

## 背景

Hugin 需要一个主 Claude 同时监督多个子 Claude，分别做实现、审核、测试、安全与验收。最初方案基于 Agent Teams 的 split panes：在 tmux 里给每个 teammate 一个窗格，主 Claude 在 lead 窗格监工。

在 Phase 0 实测中遇到三个问题：

1. **分屏不可验证**：在 WSL + Windows Terminal 下，`tmux capture-pane` 读不到 Claude TUI 内容（alternate screen），tmux server 随后消失。无法确认 `--teammate-mode tmux` 是否真的开了窗格。
2. **Agent Teams 是实验特性**：默认关闭，单团队、不可嵌套、无 resume；Windows Terminal 不是官方支持的 split-pane 终端。
3. **tmux 与 Windows 侧的交互成本高**：Windows Terminal 标签页 + tmux 会话 + 窗格三层嵌套，权限询问和滚动都更麻烦。

同期确认 Claude Code 2.1.317 已提供 **background agents / agent view**：

- `claude --bg --name <name> "<task>"` 派发独立后台会话；
- `claude agents` 看板，`claude agents --json --all` 机器可读状态；
- `claude attach / logs / stop / respawn`；
- 编辑前自动进入独立 git worktree；
- 文档明确将其定位为“由一个会话监督其他会话”的方式。

## 决策

Hugin 采用 **后台会话 + 看板**：

- 主会话是普通交互式 `claude`（Master）。
- 每个子 Claude 是一个 `claude --bg` 会话，命名 `hugin-<run>-<task>-<role>`。
- Master 通过 `claude agents --json --all` 轮询状态，`claude logs` 读输出，`claude stop` 收尾。
- 不使用 tmux，不启用 Agent Teams 分屏；项目级设置把 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 设为 `0`。
- 任务板由 Master 单写（`.hugin/runs/<run>/board.json`），子会话通过 handoff JSON 回传证据。

## 后果

**收益**

- 只依赖官方稳定接口，不解析私有 TUI 或状态文件。
- 每个 worker 有独立上下文、配额和 worktree，互不污染。
- Windows Terminal 只需要普通标签页；看板是独立标签。
- 失败可 `logs` 定位、`respawn` 重试、`attach` 人工接管。

**代价**

- 没有共享任务列表和 mailbox；Master 必须自己维护任务板，并给每个 worker 自包含提示。
- 后台会话不共享主会话对话上下文。
- 后台会话是 research preview，状态字段可能变化；因此以 `claude agents --json` 的 `state` 和 handoff 文件为准，不解析内部 job 文件。
- `claude --bg` 要求工作区已信任；首次必须人工接受信任对话框。

## 备选方案

| 方案 | 结论 |
|---|---|
| Agent Teams split panes | 放弃：实验特性、Windows Terminal 不支持分屏、Phase 0 不可验证 |
| tmux 多窗格 + `claude` | 放弃：TUI 抓取不可靠，Windows/WSL 层叠复杂 |
| in-process subagents（Agent 工具） | 保留：用于 `/review-board` 等 workflow 内部并行；不适合长时间独立任务 |
| 自建调度器 | 放弃：重复造轮子，维护成本高 |
| 后台会话 + 看板 | **采纳** |

## 相关

- 官方文档：https://code.claude.com/docs/en/agent-view
- 官方文档：https://code.claude.com/docs/en/sub-agents
- 官方文档：https://code.claude.com/docs/en/workflows
- 验证记录：[../VALIDATION.md](../VALIDATION.md)
