# 经验

一行一条：`- YYYY-MM-DD: 事实（来源）`。只写可复用、非显而易见、能改变下次做法的经验。

- 2026-11-03: `wsl.exe -e node` 会失败（node 在 nvm 下），必须 `wsl.exe -e bash -lc '...'`。（Phase 0）
- 2026-11-03: Git Bash 会把 `/mnt/d/...` 改写成 `D:/soft/Git/mnt/...`；跨 WSL 调用用 PowerShell 或脚本文件，不要直接在 Git Bash 里传 `/mnt` 路径。（Phase 0）
- 2026-11-03: `claude --bg` 在未信任目录直接拒绝；信任只能由人接受一次，不要脚本改 `~/.claude.json`。（Phase 0）
- 2026-11-03: 后台 worker 默认加载全局 OMC/Superpowers 与 ultracode，会跑偏；`--settings .claude/hugin/worker-settings.json` 可关闭。（Phase 0）
- 2026-11-03: Hook 的 stdin 字段是 `task_description`，但解析器同时兼容 `description` 和 `task.description`；合成 stdin 测试 7/7 通过。（Phase 1）
- 2026-11-03: `--settings` 只覆盖同名键，未写的键仍从项目 settings 继承；因此项目 hooks 对 worker 仍生效。（官方 CLI 文档）
- 2026-11-03: 原生 auto memory 在由另一个 Claude 会话启动的会话（含后台会话）里可能默认关闭；不能把 worker 记忆押在它上面。（官方 memory 文档）
- 2026-11-04: worktree 中的 hook 必须用 `git rev-parse --git-common-dir` 找主仓库，否则 `.hugin/runs` 与 `CURRENT_RUN` 会解析到 worktree 内。合成 worktree 测试已通过。（Phase 1）
- 2026-11-04: `SessionStart` 的 `additionalContext` 上限 10000 字符；Hugin 截到 9000。输出必须是可解析 JSON，否则整段被丢弃。（官方 hooks 文档 + 实测 1200 字符）
- 2026-11-04: 由证据推导 stage 时，`openFindings` 必须在同一函数内计算；漏掉会抛 `ReferenceError` 并让 `node --test` 挂住。（Phase 1）
- 2026-11-04: WSL 没有配置 git 身份；仓库本地设为 `Hugin <hugin@localhost>`。真实提交前应改成用户自己的身份。（Phase 1）
- 2026-11-04: `ng`/`bin/hugin` 已改为 Node CLI（`bin/hugin-cli.mjs`），Windows 原生和 WSL 共用；Windows 与 WSL 的 `claude agents` 会话注册表独立，Master 与 worker 不能跨平台混用。（Phase 1）
- 2026-11-04: `claude --bg` 继承 Master 当前 cwd；派工前先 `cd` 到目标任务 worktree，并要求 worker 先 `git rev-parse --abbrev-ref HEAD` 确认分支，否则可能在别的 worktree 上跑。（hugin-iterate T5 首版派错）
- 2026-11-04: `dist/` 与 `web/dist/` 都提交入库；只改 `src/` 不 `npm run build` 会让 hooks 与 worktree 跑到旧代码；`doctor --quick` 会检查产物是否存在并可解析。（ADR 0003）
- 2026-11-04: 用户级 `PreToolUse` hook `rtk hook claude` 会把 Bash 命令改写成 `rtk <cmd>`，allow 规则按改写后的字符串匹配；settings 必须同时列 rtk 形式，且 hook 返回 allow 不能替代显式 allow（后台会话仍会弹权限提示）。（hugin-iterate memory）
- 2026-11-04: worktree 内 `.hugin/runs` 为空（run 文件在主仓库且未被 git 跟踪）；在 worktree 跑 `status --json` 得到 `run:null`、`tasks:[]` 是环境差异，不是回归。（T5 handoff）
- 2026-11-04: Ant Design 5 使用 CSS-in-JS，运行时注入 `<style>`；CSP 必须放行 `style-src 'unsafe-inline'`，否则样式整体丢失；脚本与网络请求仍限 `'self'`。（ADR 0005）
- 2026-11-04: `collect` 会校验 handoff 的 `head`/`commit` 是否等于 worktree 当前 HEAD（允许 7 位以上短 SHA），不一致 exit 1；未声明 head 只告警。写完 handoff 后再改文件或提交会让 collect 失败。（T8）
