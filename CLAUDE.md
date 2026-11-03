# Hugin

Hugin 是一套“主 Claude 监工、多个子 Claude 分工”的工程框架。主会话负责拆解、派工、盯进度、卡门禁；子 Claude 是独立后台会话，分别做实现、审核、测试、安全与验收。

@.claude/hugin/PROTOCOL.md
@.hugin/memory/INDEX.md

## 项目事实

- 运行环境：WSL2 Ubuntu。Windows 侧用 `bin/hugin.ps1` 打开 Windows Terminal。
- 项目在 WSL 内路径：`/mnt/d/code/Hugin`。
- 主会话：交互式 `claude`（Master）。
- 子会话：`claude --bg --name hugin-<run>-<task>-<role> ...`。
- 看板：`claude agents`；机器可读状态：`claude agents --json --all`。
- 日志：`claude logs <id>`；接入：`claude attach <id>`；停止：`claude stop <id>`。
- 任务板：`.hugin/runs/<run>/board.json`（Master 是唯一写者）。
- 证据：`.hugin/runs/<run>/tasks/<task>/handoff.json`。
- 记忆：`.hugin/memory/`（跨 run）；`.hugin/runs/<run>/brief.md`（本次 run）。`SessionStart` hook 会把摘要注入每个子会话。
- 看板：`claude agents`；Web 控制台：`./bin/hugin console`（只读，127.0.0.1）。
- 不使用 tmux，不依赖 Agent Teams 分屏；所有子 Claude 都是后台会话。

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
