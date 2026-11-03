# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Hugin 是一套“主 Claude 监工、多个子 Claude 分工”的工程框架。主会话负责拆解、派工、盯进度、卡门禁；子 Claude 是独立后台会话，分别做实现、审核、测试、安全与验收。

@.claude/hugin/PROTOCOL.md
@.hugin/memory/INDEX.md

## 命令

```bash
./bin/hugin doctor --quick     # 环境自检 + 所有 node --check（Windows 可用 bin/hugin.ps1 或 ng）
```

测试：

```bash
node --test tests/*.test.mjs                                         # 全部后端测试：console 5 个 + cli 6 个
node --test --test-name-pattern="buildState" tests/console.test.mjs  # 单跑一组用例
node --test tests/cli.test.mjs                                       # work/collect 的隔离仓库测试

cd examples/fixture && python -m unittest discover -v                  # Windows
cd examples/fixture && python3 -m unittest discover -v                 # WSL / Linux
cd examples/fixture && python -m unittest test_calc.CalcTest.test_divide -v   # 单个用例
```

`examples/fixture` 初始为红（`divide` 未实现、`multiply` 用错运算符），这是设计，不是回归。

常用：

```bash
./bin/hugin start | dashboard | console | ps | attach <id> | logs <id> | stop <id>
./bin/hugin new-run [id] | work <run> <task> | collect <run> <task>
./bin/hugin memory | remember <text> | recall <query> | status [--all] | lang
```

`ng` 是 `./bin/hugin` 的快捷方式（WSL：`~/.local/bin/ng`；Windows：`%USERPROFILE%\.local\bin\ng.cmd`）。

## 架构

所有 CLI 入口最终落到 `bin/hugin-cli.mjs`（Node，启动时 `chdir` 到仓库根）：`bin/hugin`、`bin/hugin.ps1`、`bin/ng` 只是转发。加子命令只改这一个文件。

Master 与 worker 靠文件协作，不共享上下文：

- Master 用 `claude --bg --name hugin-<run>-<task>-<role>` 派后台会话，用 `claude agents --json --all` 轮询，`claude logs <id>` 读输出。
- 真相在 `.hugin/runs/<run>/`：`run.json`、`brief.md`、`board.json`、`tasks/<task>/handoff.json`、`reviews/*.json`。Master 重启后从这里重建，不依赖对话恢复。
- `SessionStart` hook 向每个 worker 注入 brief / board / 最近经验；`TaskCreated` / `TaskCompleted` hooks 卡任务字段与完成证据。
- 每个 hook 用 `repoRoot()`（`git rev-parse --git-common-dir`，见 `.claude/hooks/lib.mjs`）从 worktree 解析回主仓库，因此证据路径始终以主仓库为基准。

后台会话隔离（已实测的限制）：

- worker 不能写共享检出，也不能写主仓库的 `.hugin/runs/`。Master 先 `hugin work <run> <task>` 建 `.claude/worktrees/<run>-<task>`，在该目录内启动 worker；worker 把 handoff 写进 worktree；结束后 `hugin collect <run> <task>` 收回并校验。
- 后台会话在已存在的 worktree 中启动会跳过隔离迁移，但 commit 仍会询问；所以 worker 不提交，Master 收证据后提交分支。
- reviewer / verifier 的 `Write` 被禁用，返回 JSON，由 Master 落盘并记 `staged_by: master`。
- Windows 与 WSL 的 `claude agents` 注册表独立，Master 与 worker 必须同平台；worktree 也必须在同一平台创建（跨平台 worktree 的 `.git` 指向对方路径，会变成 `prunable`）。

## 控制台

`lib/console.mjs` 是纯状态层：`listRuns` / `buildState` 从 `.hugin/` 文件加一次 `claude agents --json` 推导 stage（`attention` / `failed` / `blocked` / `review` / `complete` / `working` / `queued`），`createConsoleServer` 只读地提供 `/api/state` 与静态资源，只绑 loopback。`web/` 是原生 HTML/CSS/JS，无构建步骤。改推导逻辑先看 `tests/console.test.mjs`。

## 门禁

- 任务必须有 `AC:` / `Evidence:` / `Owner:`；完成必须有 `handoff.json` 且 `status=complete`。
- 整体门禁：测试通过 + reviewer 无 blocker + security 无 high + verifier PASS。
- 严格模式：`/review-board`、`/pre-merge-gate`（`.claude/workflows/`），结果原样写入 run 目录。
- 不自动合并 main；合并由人决定。

## 记忆

- 跨 run 的事实写 `.hugin/memory/`（`INDEX.md` 保持 200 行以内）；本次 run 的目标写 `brief.md`，过程决策写 `memory.md`。
- 不写密钥、token、隐私、易变日志。
- 记忆不是证据：完成仍以 handoff、命令输出、review/verdict 为准。

## 项目事实

- 运行环境：Windows 原生或 WSL2 Ubuntu。项目路径 `D:\code\Hugin` / `/mnt/d/code/Hugin`。
- 主会话：交互式 `claude`（Master）。子会话：`claude --bg --name ...`。
- 看板 `claude agents`；接入 `claude attach <id>`；停止 `claude stop <id>`。
- 不使用 tmux，不依赖 Agent Teams 分屏。
- Web 控制台：`ng console`（只读，127.0.0.1）。
