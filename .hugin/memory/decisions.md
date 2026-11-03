# 决策记忆

只记录跨 run 仍然成立、且不能从代码或 git 历史直接推出的决策。每条注明日期与 ADR 链接。

- 2026-11-03 采用后台会话 + 看板，弃用 tmux / Agent Teams 分屏。理由与代价见 `docs/decisions/0001-background-sessions.md`。
- 2026-11-03 记忆采用四层结构（原生 auto memory / `.hugin/memory/` / run 记忆 / CLAUDE.md），不引入自建数据库；claude-mem 仅作可选检索增强。见 `docs/decisions/0002-memory-layers.md`。
- 2026-11-03 门禁以文件和命令输出为准，不以对话记忆为准；`handoff.json` 是任务完成的唯一凭据。
- 2026-11-04 源码全量迁移到 TypeScript（`src/` → `dist/`），`dist/` 与 `web/dist/` 提交入库；薄启动器只设 `HUGIN_ROOT` 并 import `dist/`，hooks 启动器不 chdir。见 `docs/decisions/0003-typescript-dist.md`。
- 2026-11-04 任务检查点 = worktree 提交 + 注解 tag `hugin/<run>/<task>` + run 级 `checkpoints.json`；`rollback` 只创建还原分支，不 reset、不 rebase、不推 main。见 `docs/decisions/0004-git-checkpoints.md`。
- 2026-11-04 Web 控制台改为全中文管理后台（React 18 + Ant Design 5 + Vite，`web/dist/` 入库）；只读、loopback、3 秒轮询 `/api/state`；CSP 为 antd 放行 `style-src 'unsafe-inline'`。见 `docs/decisions/0005-console-admin-ui.md`。
