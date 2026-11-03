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

CLI：ng / bin/hugin / bin/hugin.ps1 → bin/hugin-cli.mjs（薄启动器，设置 HUGIN_ROOT 并 chdir）→ dist/cli/main.js；源码在 src/cli/main.ts，改完 npm run build

每个 Worker
  ├─ 独立上下文 + 独立配额
  ├─ 编辑前自动进入自己的 git worktree（git 仓库内）
  ├─ 写 .hugin/runs/<run>/tasks/<task>/handoff.json
  └─ 由 TaskCreated / TaskCompleted hooks 约束任务格式与完成证据
```

Windows 与 WSL 的 `claude agents` 会话注册表彼此独立；Master 与 worker 必须在同一平台。`.hugin/runs` 文件证据两边共享。

## 代码布局

Hugin 的运行时代码是 TypeScript，构建产物提交入库；两个入口都是薄启动器：

```
src/
├─ cli/main.ts            # 所有 hugin 子命令（含 status / checkpoint / collect）
├─ cli/console-main.ts    # console 服务进程
├─ lib/console.ts         # 只读 HTTP 服务 + 状态推导（buildState / summary / queue）
├─ lib/checkpoints.ts     # checkpoint / checkpoints / rollback 与台账
├─ hooks/*.ts             # SessionStart / TaskCreated / TaskCompleted
└─ tests/*.ts             # node --test 测试，编译到 dist/tests/

dist/                     # tsc 产物（提交入库）
web/src/                  # React 18 + Ant Design 5 管理后台源码
web/dist/                 # Vite 产物（提交入库）
bin/hugin-cli.mjs         # 设置 HUGIN_ROOT + chdir(ROOT) → import dist/cli/main.js
bin/hugin-console.mjs     # 同上 → import dist/cli/console-main.js
.claude/hooks/*.mjs       # 设置 HUGIN_ROOT → import dist/hooks/*.js；不 chdir（保留真实 cwd）
```

`dist/` 必须与 `src/` 同步提交：hooks 和 worktree 不经过构建步骤就直接运行 `dist/`。改源码后 `npm run build`（= `build-ts` + `build-web`）。

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
| `hugin status` | 复用 console 状态层：counts、就绪队列、任务阶段、会话；`--json` / `--watch` |
| `hugin checkpoint` | 提交任务 worktree、打 `hugin/<run>/<task>` 注解 tag、写 `checkpoints.json` 台账 |
| `hugin rollback` | 只创建/切换到还原分支，不 reset、不重写历史 |
| console（`src/lib/console.ts`） | 只读 HTTP：`/api/state` 的 `summary` / `queue` + 静态资源 |
| `web/` | React 18 + Ant Design 5 中文管理后台，3 秒轮询 |

## 数据流

1. Master 写 `run.json`、`brief.md`、`board.json`，建任务。
2. Master 用 `claude --bg` 派 worker，把任务、AC、文件、证据路径、基线 commit、brief 摘录全部写进提示。
3. `SessionStart` hook 在每个会话启动时注入 run brief、板状态、最近经验。
4. Master 先 `hugin work <run> <task>` 建隔离 worktree 并在其中启动 worker。Worker 只改 worktree、留改动不提交，把 `handoff.json`（含 `branch` / `worktree` / `head` 与 `memory_candidates`）写进 worktree。
5. Master 轮询 `claude agents --json --all`；`done` 后 `hugin collect` 只收回 handoff 与 `commands_run[].log` 引用的日志，校验 run/task、ac 与 head 新鲜度，写 `collected.json`。随后 `hugin checkpoint <run> <task>` 提交 worktree、打注解 tag 并追加 `checkpoints.json`。终端 `hugin status --watch` 与 Web 控制台读同一份文件状态。
6. Master 派 3 个 reviewer（不同 lens）和 verifier；它们只读，把 findings / verdict JSON 作为最终消息返回，由 Master 落盘到 `reviews/`。collect 不回收这些文件。
7. 任一门禁失败 → 建修复任务，重新派 implementer；最多 3 轮。需要回退时用 `hugin rollback` 建还原分支，避免破坏性 reset。
8. 全部通过 → `final-report.md`；Master 把可复用经验提升到 `.hugin/memory/`；合并由人决定。

## 记忆

四层，详见 [memory.md](memory.md) 与 [ADR 0002](decisions/0002-memory-layers.md)：

1. `CLAUDE.md` / `PROTOCOL.md`：规则与角色，每个会话加载。
2. `.hugin/memory/`：跨 run 的事实；`INDEX.md` 随 `CLAUDE.md` 加载。
3. `.hugin/runs/<run>/brief.md` + `memory.md`：本次 run 的上下文；`SessionStart` 注入摘要。
4. 原生 auto memory：Master 的个人自动笔记，不作为团队事实来源。

关键点：worker 在隔离 worktree 里，`repoRoot()` 用 `git rev-parse --git-common-dir` 解析主仓库，因此 run 证据、`CURRENT_RUN`、项目记忆都能读到。Evidence 路径以主仓库为基准解析，不依赖 worker 的 cwd；worker 写在 worktree 内的 handoff 由 `hugin collect` 复制回主仓库。

## 控制台与状态

`src/lib/console.ts` 的 `buildState` 只读地读取 `.hugin/runs/`、`.hugin/memory/`，并调用一次 `claude agents --json --all`。它把每个任务推导成 stage（`attention` / `failed` / `blocked` / `review` / `complete` / `working` / `queued`），并汇总：

- `summary`：`running`（本 run 的 `working` 会话）、`queued`（pending 且依赖已完成的就绪任务）、`review`（handoff complete 但未 PASS）、`blocked`、`complete`；
- `queue`：就绪任务，按 `board.json` 顺序。

`createConsoleServer` 只提供 `GET /healthz`、`/api/runs`、`/api/state` 和静态资源，绑定 loopback。静态资源优先 `web/dist`（Vite 产物），未构建时回退 `web/`。CSP 为 antd 的 CSS-in-JS 放行 `style-src 'unsafe-inline'`。

`hugin status` 复用同一个 `buildState`：文本模式打印 repo/run/lang、计数、队列与会话；`--json` 输出 `{repo,run,language,counts,queue,tasks,workers,console}`；`--watch` 默认每 5 秒清屏重绘，Ctrl-C 退出 0。`hugin start` 通过 `ensureConsole` 后台拉起控制台（pidfile + healthz 防重复），`console --status` / `--stop` 管理。

前端是 React 18 + Ant Design 5 的中文管理后台（侧栏：概览 / 任务 / 后台会话 / 运行记录），每 3 秒轮询 `/api/state`。详见 [console.md](console.md) 与 [ADR 0005](decisions/0005-console-admin-ui.md)。

## 恢复模型

后台会话的对话在 supervisor 中持久化，`claude agents --json --all` 可以看到已完成/已停止的会话；`claude attach` 或 `claude --resume <sessionId>` 可以继续。但不要依赖对话恢复：**run 的真相在文件里**——`run.json`、`board.json`、handoff、`collected.json`、`checkpoints.json`、reviews、verdict。Master 重启后从这些文件重建上下文。

## 安全模型

- 不使用 `--dangerously-skip-permissions`。
- worker 设置禁止 `git push`，项目设置禁止 force-push、hard reset、`rm -rf`。
- reviewer/verifier 工具白名单只读。
- 敏感文件（`.env`、`~/.ssh`）在项目设置中 deny。
- 权限询问由人处理；Master 不猜、不代批。
