# 决策记忆

只记录跨 run 仍然成立、且不能从代码或 git 历史直接推出的决策。每条注明日期与 ADR 链接。

- 2026-11-03 采用后台会话 + 看板，弃用 tmux / Agent Teams 分屏。理由与代价见 `docs/decisions/0001-background-sessions.md`。
- 2026-11-03 记忆采用四层结构（原生 auto memory / `.hugin/memory/` / run 记忆 / CLAUDE.md），不引入自建数据库；claude-mem 仅作可选检索增强。见 `docs/decisions/0002-memory-layers.md`。
- 2026-11-03 门禁以文件和命令输出为准，不以对话记忆为准；`handoff.json` 是任务完成的唯一凭据。
