# Hugin

Hugin 是一套“主 Claude 监工、多个子 Claude 分工”的工程框架。主会话负责拆解、派工、盯进度、卡门禁；子 Claude 是独立后台会话，分别做实现、审核、测试、安全与验收。

@.claude/hugin/PROTOCOL.md
@.hugin/memory/INDEX.md

## 项目事实

- 运行环境：Windows 原生或 WSL2 Ubuntu。`ng` / `bin/hugin` 统一走 Node CLI（`bin/hugin-cli.mjs`），不强制跳 WSL。
- 项目路径：`D:\code\Hugin`（Windows）/ `/mnt/d/code/Hugin`（WSL）。
- 主会话：交互式 `claude`（Master）。
- 子会话：`claude --bg --name hugin-<run>-<task>-<role> ...`。
- 看板：`claude agents`；机器可读状态：`claude agents --json --all`。
- 日志：`claude logs <id>`；接入：`claude attach <id>`；停止：`claude stop <id>`。
- 任务板：`.hugin/runs/<run>/board.json`（Master 是唯一写者）。
- 证据：`.hugin/runs/<run>/tasks/<task>/handoff.json`。
- 记忆：`.hugin/memory/`（跨 run）；`.hugin/runs/<run>/brief.md`（本次 run）。`SessionStart` hook 会把摘要注入每个子会话。
- Web 控制台：`ng console`（只读，127.0.0.1）。
- 不使用 tmux，不依赖 Agent Teams 分屏；所有子 Claude 都是后台会话。
- Windows 与 WSL 的 `claude agents` 后台会话注册表独立；Master 与 worker 必须在同一平台，不要混用。

## 记忆规则

- 跨 run 的事实写 `.hugin/memory/`；索引 `INDEX.md` 保持 200 行以内。
- 本次 run 的目标与约束写 `brief.md`；过程中的决策写 `memory.md`。
- 不写密钥、token、隐私、易变日志。
- 记忆不是证据：完成仍以 handoff、命令输出、review/verdict 为准。

## 快速命令

```bash
./bin/hugin doctor          # 环境自检
./bin/hugin start           # 启动主会话
./bin/hugin dashboard       # 打开 claude agents 看板
./bin/hugin console         # Web 控制台 http://127.0.0.1:8787
./bin/hugin memory          # 项目记忆索引 + 最近经验
./bin/hugin ps              # 打印后台会话 JSON
./bin/hugin new-run         # 新建一次 run
```
