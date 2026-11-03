# 术语表

| 术语 | 含义 |
|---|---|
| Master | 主会话 Claude；唯一协调者，负责拆解、派工、监工、门禁、报告 |
| Worker | `claude --bg` 启动的后台子会话 |
| run | 一次受监督的工作单元；目录 `.hugin/runs/<run>/` |
| board | run 级任务板 `board.json`，Master 单写 |
| handoff | 任务完成证据 `tasks/<task>/handoff.json` |
| lens | reviewer 的审查视角：`correctness` / `security` / `tests` |
| gate | 整体门禁：测试 + 审查 + 验收的共同结论 |
| verdict | verifier 的结论：`PASS` / `BLOCK` / `INCOMPLETE` |
| brief | 每个 run 的上下文简报 `brief.md`，Master 写、worker 读 |
| 记忆提升 | run 结束后把可复用经验从 run 目录移到 `.hugin/memory/` |
