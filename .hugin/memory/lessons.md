# 经验

一行一条：`- YYYY-MM-DD: 事实（来源）`。只写可复用、非显而易见、能改变下次做法的经验。

- 2026-11-03: `wsl.exe -e node` 会失败（node 在 nvm 下），必须 `wsl.exe -e bash -lc '...'`。（Phase 0）
- 2026-11-03: Git Bash 会把 `/mnt/d/...` 改写成 `D:/soft/Git/mnt/...`；跨 WSL 调用用 PowerShell 或脚本文件，不要直接在 Git Bash 里传 `/mnt` 路径。（Phase 0）
- 2026-11-03: `claude --bg` 在未信任目录直接拒绝；信任只能由人接受一次，不要脚本改 `~/.claude.json`。（Phase 0）
- 2026-11-03: 后台 worker 默认加载全局 OMC/Superpowers 与 ultracode，会跑偏；`--settings .claude/hugin/worker-settings.json` 可关闭。（Phase 0）
- 2026-11-03: Hook 的 stdin 字段是 `task_description`，但解析器同时兼容 `description` 和 `task.description`；合成 stdin 测试 7/7 通过。（Phase 1）
- 2026-11-03: `--settings` 只覆盖同名键，未写的键仍从项目 settings 继承；因此项目 hooks 对 worker 仍生效。（官方 CLI 文档）
- 2026-11-03: 原生 auto memory 在由另一个 Claude 会话启动的会话（含后台会话）里可能默认关闭；不能把 worker 记忆押在它上面。（官方 memory 文档）
