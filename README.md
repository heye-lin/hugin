# Hugin

Hugin 是一套“主 Claude 监工、多个后台子 Claude 分工”的工程框架。它不重新实现调度器，而是直接使用 Claude Code 2.1.317 自带的能力：

- **主会话（Master）**：交互式 Claude，负责拆解、派工、盯进度、卡门禁、写最终报告。
- **子会话（Workers）**：`claude --bg` 后台会话，分别做实现、审查、测试、安全、验收。
- **看板**：`claude agents` / `claude agents --json --all`。
- **任务与证据**：`.hugin/runs/<run>/` 下的 `board.json`、`handoff.json`、review/verdict。
- **记忆**：`.hugin/memory/`（跨 run）+ `.hugin/runs/<run>/brief.md`（本次 run）；`SessionStart` hook 把摘要注入每个子会话。
- **Web 控制台**：`./bin/hugin console`，只读，编辑杂志风（`editorial` skill）。
- **硬门禁**：`TaskCreated` / `TaskCompleted` hooks，缺字段或缺证据直接阻断。
- **可选严格门禁**：`/review-board`、`/pre-merge-gate` 动态工作流（并行审查 + 对抗验证）。

不使用 tmux，不使用 Agent Teams 分屏；所有子 Claude 都是独立后台会话。

## 前置条件

- Windows 11 + WSL2 Ubuntu
- WSL 内已安装：`claude`（2.1.317+）、`node`、`git`、`curl`
- 本地代理可达：`http://127.0.0.1:3425`（WSL 镜像网络下 `127.0.0.1` 可用）
- 项目已 `git init`（后台会话的工作树隔离依赖 git）

## 第一次使用

1. 在 Windows Terminal 打开 Ubuntu：
   ```bash
   cd /mnt/d/code/Hugin
   ./bin/hugin doctor
   ```
2. 第一次启动会要求信任该目录；接受一次即可：
   ```bash
   ./bin/hugin start
   ```
   进入主会话后可以先用 `/status` 确认环境，然后退出。
3. 再开一个标签页打开看板：
   ```bash
   cd /mnt/d/code/Hugin
   ./bin/hugin dashboard
   ```
   或者打开 Web 控制台（只读）：
   ```bash
   ./bin/hugin console
   # http://127.0.0.1:8787
   ```
   或者从 Windows 侧一键开两个标签：
   ```powershell
   .\bin\hugin.ps1
   ```

## 跑一次受监督的任务

在主会话里输入：

```text
/hugin-run 实现 examples/fixture 里的 divide，并修复 multiply 的 bug
```

或直接对 Master 说：

```text
用 Hugin 跑这个需求：<需求>
```

Master 会：

1. `bin/hugin new-run` 建 run；
2. 拆任务并写 `board.json`；
3. 用 `claude --bg` 派 implementer；
4. 用 `claude agents --json --all` 监工；
5. 派 3 个 reviewer（correctness / security / tests）和 verifier；
6. 汇总证据、写 `final-report.md`；
7. 是否合并由你决定。

## 目录

```
.claude/agents/       角色定义（planner / implementer / reviewer / verifier）
.claude/hooks/        SessionStart 记忆注入 + TaskCreated / TaskCompleted 门禁
.claude/skills/       /hugin-run 监工手册、editorial 视觉风格
.claude/workflows/    /review-board、/pre-merge-gate 严格门禁
.claude/hugin/        PROTOCOL.md、worker-settings.json
bin/                  hugin 命令、Windows 启动器、console 入口
lib/                  console 后端（只读 HTTP + 状态推导）
web/                  console 前端（原生 HTML/CSS/JS）
tests/                console 测试（node --test）
docs/                 架构、操作手册、任务格式、记忆、控制台、验证记录
.hugin/memory/        跨 run 记忆（提交入库）
.hugin/runs/          每次 run 的任务板、证据、报告（已 gitignore）
examples/fixture/     冒烟测试用最小 Python 模块
```

## 常用命令

```bash
./bin/hugin doctor          # 自检
./bin/hugin doctor --quick  # 跳过耗时检查
./bin/hugin start           # 主会话
./bin/hugin dashboard       # 看板
./bin/hugin console         # Web 控制台 http://127.0.0.1:8787
./bin/hugin memory          # 项目记忆索引 + 最近经验
./bin/hugin remember "..."  # 追加一条经验
./bin/hugin recall "..."    # 搜索记忆与 run 证据
./bin/hugin ps              # 后台会话 JSON
./bin/hugin status [--all]  # 当前 run + Hugin 会话（--all 含已停止）
./bin/hugin attach <id>     # 接入某个子会话
./bin/hugin logs <id>       # 看子会话输出
./bin/hugin stop <id>       # 停止子会话
./bin/hugin new-run         # 新建 run
```

## 快捷命令 `ng`

`ng` 等价于 `./bin/hugin`，已注册到两个位置：

- WSL：`~/.local/bin/ng` → `bin/ng`
- Windows：`%USERPROFILE%\.local\bin\ng.cmd`，经 WSL 登录 shell 执行

```bash
ng doctor        # 自检
ng start         # 主会话
ng console       # Web 控制台
```

换机器后重新注册：

```bash
ln -sfn /mnt/d/code/Hugin/bin/ng ~/.local/bin/ng
```

Windows 侧把 `ng.cmd` 放到任意 PATH 目录即可（当前为 `C:\Users\10438\.local\bin`）。

## 限制

- 后台会话是 research preview；状态字段与 UI 可能变化。Hugin 以 `claude agents --json` 和 handoff 文件为准，不解析 `~/.claude/jobs/`。
- 子会话不共享主会话的对话上下文；每次派工必须给自包含提示。
- 权限询问需要人 `attach` 处理；框架不自动批准。
- 不自动合并到 main。
- 子会话默认不加载 OMC/Superpowers 插件（见 `.claude/hugin/worker-settings.json`），避免 hook 噪音和额外 token。

## 文档

- [架构](docs/architecture.md)
- [操作手册](docs/runbook.md)
- [任务与证据格式](docs/task-format.md)
- [记忆](docs/memory.md)
- [Web 控制台](docs/console.md)
- [Phase 0 验证记录](docs/VALIDATION.md)
- [决策 0001：后台会话](docs/decisions/0001-background-sessions.md)
- [决策 0002：分层记忆](docs/decisions/0002-memory-layers.md)
