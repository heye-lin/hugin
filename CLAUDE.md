# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Hugin 是一套“主 Claude 监工、多个子 Claude 分工”的工程框架。主会话负责拆解、派工、盯进度、卡门禁；子 Claude 是独立后台会话，分别做实现、审核、测试、安全与验收。

@.claude/hugin/PROTOCOL.md
@.hugin/memory/INDEX.md

## 命令

```bash
./bin/hugin doctor --quick     # 环境自检 + dist/ 与所有启动器/hooks 的 node --check（Windows 可用 bin/hugin.ps1 或 ng）
```

构建与测试（TypeScript 源码在 `src/`，`tsc` 输出到 `dist/`；前端源码在 `web/`，Vite 输出到 `web/dist/`。两份产物都提交入库，改源码后必须重新构建）：

```bash
npm install                                                          # typescript、@types/node、React/Ant Design、Vite
npm run build                                                        # build-ts（tsc -p tsconfig.json）+ build-web（vite build）
npm run build-ts                                                     # 只编译 TS，输出 dist/
npm run typecheck                                                    # tsc --noEmit，只做类型检查
npm test                                                             # build-ts 后跑 dist/tests/*.test.js（43 个）
node --test dist/tests/*.test.js                                     # 不重新构建，直接跑已编译测试
node --test --test-name-pattern="buildState" dist/tests/console.test.js   # 单跑一组用例
node --test dist/tests/cli.test.js                                   # work/collect/checkpoint 的隔离仓库测试

cd examples/fixture && python -m unittest discover -v                  # Windows
cd examples/fixture && python3 -m unittest discover -v                 # WSL / Linux
cd examples/fixture && python -m unittest test_calc.CalcTest.test_divide -v   # 单个用例
```

`bin/*.mjs` 与 `.claude/hooks/*.mjs` 只是薄启动器：设置 `HUGIN_ROOT` 后加载 `dist/`，缺构建产物时会提示 `npm run build`。`bin/hugin-cli.mjs` / `bin/hugin-console.mjs` 会 `chdir` 到仓库根；`.claude/hooks/*.mjs` **不 chdir**，要保留 Claude 传入的真实 cwd。

`examples/fixture` 初始为红（`divide` 未实现、`multiply` 用错运算符），这是设计，不是回归。

常用：

```bash
./bin/hugin start [--no-console] [--port N] | dashboard | console [--status|--stop] | ps | attach <id> | logs <id> | stop <id>
./bin/hugin status [--all] [--json] [--watch [--interval N]]
./bin/hugin new-run [id] | work <run> <task> | collect <run> <task>
./bin/hugin checkpoint <run> <task> [--note <text>] [--no-push] | checkpoints <run> [--json] | rollback <run> <task> [--dry-run]
./bin/hugin memory | remember <text> | recall <query> | lang
```

`ng` 是 `./bin/hugin` 的快捷方式（WSL：`~/.local/bin/ng`；Windows：`%USERPROFILE%\.local\bin\ng.cmd`）。

## 架构

CLI 入口：`bin/hugin`、`bin/hugin.ps1`、`bin/ng` 转发到 `bin/hugin-cli.mjs`；它设置 `HUGIN_ROOT`、`chdir` 到仓库根，再加载 `dist/cli/main.js`。子命令实现在 `src/cli/main.ts`，改完必须 `npm run build`。控制台入口同理：`bin/hugin-console.mjs` → `dist/cli/console-main.js`。

Master 与 worker 靠文件协作，不共享上下文：

- Master 用 `claude --bg --name hugin-<run>-<task>-<role>` 派后台会话，用 `claude agents --json --all` 轮询，`claude logs <id>` 读输出。
- 真相在 `.hugin/runs/<run>/`：`run.json`、`brief.md`、`board.json`、`tasks/<task>/handoff.json`、`tasks/<task>/collected.json`、`checkpoints.json`、`reviews/*.json`。Master 重启后从这里重建，不依赖对话恢复。
- `SessionStart` hook 向每个 worker 注入 brief / board / 最近经验；`TaskCreated` / `TaskCompleted` hooks 卡任务字段与完成证据。
- 每个 hook 用 `repoRoot()`（`git rev-parse --git-common-dir`，见 `src/hooks/lib.ts`）从 worktree 解析回主仓库，因此证据路径始终以主仓库为基准。

后台会话隔离（已实测的限制）：

- worker 不能写共享检出，也不能写主仓库的 `.hugin/runs/`。Master 先 `hugin work <run> <task>` 建 `.claude/worktrees/<run>-<task>`，在该目录内启动 worker；worker 把 handoff 写进 worktree；结束后 `hugin collect <run> <task>` 只收回 handoff 与 `commands_run[].log` 引用的日志并校验（run/task 一致、ac 非空、声明 head 与 worktree HEAD 一致），写 `collected.json`。collect 不收回 review/verdict。
- 后台会话在已存在的 worktree 中启动会跳过隔离迁移，但 commit 仍会询问；所以 worker 不提交，Master 收完证据后用 `hugin checkpoint <run> <task>` 提交、打 tag 并记台账。
- reviewer / verifier 的 `Write` 被禁用，返回 JSON，由 Master 落盘并记 `staged_by: master`。
- Windows 与 WSL 的 `claude agents` 注册表独立，Master 与 worker 必须同平台；worktree 也必须在同一平台创建（跨平台 worktree 的 `.git` 指向对方路径，会变成 `prunable`）。

## 控制台与状态

`src/lib/console.ts` 是纯状态层：`listRuns` / `buildState` 从 `.hugin/` 文件加一次 `claude agents --json` 推导 stage（`attention` / `failed` / `blocked` / `review` / `complete` / `working` / `queued`），并汇总 `summary`（running / queued / review / blocked / complete）与 `queue`（pending 且依赖已完成，按 board 顺序）。`createConsoleServer` 只读地提供 `/api/state` 与静态资源，只绑 loopback；静态资源优先 `web/dist`，缺失时回退 `web/`。前端是 React 18 + Ant Design 5 的中文管理后台，每 3 秒轮询 `/api/state`。`src/cli/main.ts` 的 `hugin status` 复用同一份汇总，`--json` 给机器读，`--watch` 清屏重绘。改推导逻辑先看 `src/tests/console.test.ts`。

`hugin start` 默认调用 `ensureConsole` 在后台拉起控制台：pid 写 `.hugin/console.pid`，日志写 `.hugin/logs/console.log`，用 `/healthz` 健康检查并防重复；`--no-console` 跳过，`--port` / `HUGIN_CONSOLE_PORT` 默认 8787。`hugin console --status` / `--stop` 查看或停止。

## 检查点

`hugin checkpoint <run> <task>` 在任务 worktree 里提交改动、打注解 tag `hugin/<run>/<task>`，并追加 `.hugin/runs/<run>/checkpoints.json` 台账；默认 push 分支与 tag，`--no-push` 跳过。`hugin checkpoints <run>` 列出台账；`hugin rollback <run> <task>` 只创建/切换到指向 tag 的还原分支，不 reset、不重写历史，拒绝脏工作区与 main/master。

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
- Web 控制台：`ng console`（只读，127.0.0.1）；`ng start` 默认在后台拉起，`console --status/--stop` 管理。
- 运行可见性：`ng status`（文本）、`--json`（机器读）、`--watch`（默认 5 秒刷新）。
- 任务收尾：`collect`（handoff + logs）→ `checkpoint`（commit + tag + 台账）→ reviewer/verifier。
