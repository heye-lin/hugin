# 架构

## 拓扑

```
宿主（Windows 原生 或 WSL2 Ubuntu）
├─ 窗口 "Hugin Master"  交互式 Claude（Master）
├─ 窗口 "Hugin Agents"  claude agents 看板
└─ 其他窗口            claude attach <id>（需要人工处理权限时）

Master（Bash / PowerShell 工具）
  ├─ claude --bg --name hugin-<run>-T1-impl --agent hugin-implementer ...
  ├─ claude --bg --name hugin-<run>-T1-review-security --agent hugin-reviewer ...
  ├─ claude --bg --name hugin-<run>-T1-verify --agent hugin-verifier ...
  ├─ claude agents --json --all        # 轮询状态
  ├─ claude logs <id>                  # 读取输出
  └─ claude stop/respawn/attach <id>   # 控制

CLI：ng / bin/hugin / bin/hugin.ps1 → bin/hugin-cli.mjs（Node，跨平台）

每个 Worker
  ├─ 独立上下文 + 独立配额
  ├─ 编辑前自动进入自己的 git worktree（git 仓库内）
  ├─ 写 .hugin/runs/<run>/tasks/<task>/handoff.json
  └─ 由 TaskCreated / TaskCompleted hooks 约束任务格式与完成证据
```

Windows 与 WSL 的 `claude agents` 会话注册表彼此独立；Master 与 worker 必须在同一平台。`.hugin/runs` 文件证据两边共享。

## 为什么用后台会话，而不是 Agent Teams / tmux

- **官方支持的状态接口**：`claude agents --json` 是文档明确给出的、供另一个 Claude 会话监工使用的接口。
- **独立上下文与配额**：每个 worker 是一个完整会话，适合审核、测试、安全这种彼此独立的视角。
- **自动工作树隔离**：后台会话在编辑前会移动到 `.claude/worktrees/` 下的独立 worktree，避免并行写冲突。
- **Windows / WSL 双平台**：CLI 由 Node 实现，不依赖 tmux 或 iTerm2 分屏；Windows Terminal 只需普通标签页。Windows 原生与 WSL 二选一，不要混用两边的后台会话。
- **Agent Teams 是实验特性**：默认禁用，且分屏在 Windows Terminal 下不受支持。Hugin 关闭了项目级 teams（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0`），避免具名 subagent 意外变成 teammate。

代价：后台会话之间没有共享任务列表和 mailbox；因此由 Master 维护 `board.json` 作为唯一任务板，worker 通过 handoff 文件回传结果。

## 组件

| 组件 | 作用 |
|---|---|
| Master | 唯一协调者；拆解、派工、轮询、门禁、报告；不实现、不签字 |
| `hugin-planner` | 只读拆解，输出任务表 |
| `hugin-implementer` | 单任务实现；写 handoff；不审自己 |
| `hugin-reviewer` | 只读；按 lens 输出 findings，不给最终裁决 |
| `hugin-verifier` | 只读；独立复跑命令，给 PASS/BLOCK/INCOMPLETE |
| `board.json` | Master 单写者的 run 级任务板 |
| `handoff.json` | 每个任务的完成证据 |
| `.hugin/memory/` | 跨 run 的项目记忆（索引 + 决策 + 经验） |
| `SessionStart` hook | 把 run brief、任务板、最近经验注入每个会话 |
| hooks | `TaskCreated` 校验任务字段；`TaskCompleted` 校验 handoff |
| workflows | `/review-board` 三视角 + 对抗验证；`/pre-merge-gate` 测试 + 审查 + 决策 |
| console | 只读 Web 看板：attention-first、任务证据、会话、记忆 |

## 数据流

1. Master 写 `run.json`、`brief.md`、`board.json`，建任务。
2. Master 用 `claude --bg` 派 worker，把任务、AC、文件、证据路径、基线 commit、brief 摘录全部写进提示。
3. `SessionStart` hook 在每个会话启动时注入 run brief、板状态、最近经验。
4. Worker 在 worktree 中工作，提交，写 `handoff.json`（含 `memory_candidates`）。
5. Master 轮询 `claude agents --json --all`；`done` 后读 handoff。也可以打开 `./bin/hugin console` 看同一份文件状态。
6. Master 派 3 个 reviewer（不同 lens）和 verifier；它们写 reviews/verdict。
7. 任一门禁失败 → 建修复任务，重新派 implementer；最多 3 轮。
8. 全部通过 → `final-report.md`；Master 把可复用经验提升到 `.hugin/memory/`；合并由人决定。

## 记忆

四层，详见 [memory.md](memory.md) 与 [ADR 0002](decisions/0002-memory-layers.md)：

1. `CLAUDE.md` / `PROTOCOL.md`：规则与角色，每个会话加载。
2. `.hugin/memory/`：跨 run 的事实；`INDEX.md` 随 `CLAUDE.md` 加载。
3. `.hugin/runs/<run>/brief.md` + `memory.md`：本次 run 的上下文；`SessionStart` 注入摘要。
4. 原生 auto memory：Master 的个人自动笔记，不作为团队事实来源。

关键点：worker 在 worktree 里，`repoRoot()` 用 `git rev-parse --git-common-dir` 解析主仓库，因此 run 证据、`CURRENT_RUN`、项目记忆都能读到。Evidence 路径以主仓库为基准解析，不依赖 worker 的 cwd。

## 控制台

`./bin/hugin console` 启动一个 Node 标准库 HTTP 服务，只读地读取 `.hugin/runs/`、`.hugin/memory/`，并调用一次 `claude agents --json --all` 获取会话状态。前端是原生 HTML/CSS/JS，使用项目内安装的 `editorial` skill；绑定 loopback，无写接口。

信息层级参考 dsh-superagent-prototype 的面板：先“需要人处理的事项”，再健康状态，最后历史；阶段由证据推导，计数可核查。详见 [console.md](console.md)。

## 恢复模型

后台会话的对话在 supervisor 中持久化，`claude agents --json --all` 可以看到已完成/已停止的会话；`claude attach` 或 `claude --resume <sessionId>` 可以继续。但不要依赖对话恢复：**run 的真相在文件里**——`run.json`、`board.json`、handoff、reviews、verdict。Master 重启后从这些文件重建上下文。

## 安全模型

- 不使用 `--dangerously-skip-permissions`。
- worker 设置禁止 `git push`，项目设置禁止 force-push、hard reset、`rm -rf`。
- reviewer/verifier 工具白名单只读。
- 敏感文件（`.env`、`~/.ssh`）在项目设置中 deny。
- 权限询问由人处理；Master 不猜、不代批。
