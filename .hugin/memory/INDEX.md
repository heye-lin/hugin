# Hugin 记忆索引

> 一行一条，指向真相所在；细节放专题文件。保持 200 行以内。
> 写入规则见 `docs/memory.md`。禁止记录密钥、token、个人隐私和易变日志。

## 环境

- Windows 原生或 WSL2 Ubuntu；项目 `D:\code\Hugin` / `/mnt/d/code/Hugin`；命令统一 `ng`（Node CLI）。→ `docs/runbook.md`
- 首次 `claude --bg` 前必须人工接受一次 workspace trust，脚本不能代做。→ `docs/VALIDATION.md`
- Node 24+；`npm install` 后才能构建/测试；`dist/` 与 `web/dist/` 都是提交入库的产物。→ `docs/runbook.md`

## 架构

- 全量 TypeScript：`src/{cli,lib,hooks,tests}` → `dist/`；`bin/*.mjs` 与 `.claude/hooks/*.mjs` 只是薄启动器。→ `docs/decisions/0003-typescript-dist.md`
- Master 用后台会话 + `claude agents` 监工；不用 tmux / Agent Teams 分屏。→ `docs/decisions/0001-background-sessions.md`
- 角色：planner / implementer / reviewer（3 lens）/ verifier；实现者不审自己。→ `.claude/hugin/PROTOCOL.md`
- 记忆分四层：原生 auto memory、`.hugin/memory/`、run 记忆、CLAUDE.md。→ `docs/decisions/0002-memory-layers.md`
- 只读 Web 控制台：`./bin/hugin console`，中文管理后台（React 18 + Ant Design 5，3 秒轮询 `/api/state`）。→ `docs/console.md`
- 检查点：`checkpoint` 提交 worktree + 注解 tag `hugin/<run>/<task>` + `checkpoints.json` 台账；`rollback` 只建还原分支。→ `docs/decisions/0004-git-checkpoints.md`
- 可见性：`hugin status`（文本）/ `--json` / `--watch`，与 `/api/state` 的 `summary` / `queue` 同源。→ `docs/console.md`

## 门禁

- 任务必须有 `AC:` / `Evidence:` / `Owner:`；完成必须有 `handoff.json` 且 `status=complete`。→ `docs/task-format.md`
- `collect` 只收 handoff 与引用日志，校验 run/task、ac 非空、head 新鲜度；不收回 review/verdict。→ `docs/task-format.md` §2.1
- 整体门禁：测试通过 + reviewer 无 blocker + security 无 high + verifier PASS。→ `.claude/hugin/PROTOCOL.md`

## 经验

- 后台 worker 会加载全局 OMC/ultracode；派工时必须带 `worker-settings.json`。→ `.claude/hugin/worker-settings.json`
- `SessionStart` hook 会把当前 run 摘要注入每个子会话；这是跨会话记忆的主通道。→ `src/hooks/session-start.ts`
- worktree 里的 hook 用 `git rev-parse --git-common-dir` 回到主仓库解析证据与记忆。→ `src/hooks/lib.ts`
- fixture 初始为红：`divide` 未实现、`multiply` 用错运算符。→ `examples/fixture/requirements/add-feature.md`

## 未决

- 异族模型探测未执行；reviewer/verifier 暂用 `inherit`。→ `docs/VALIDATION.md`
- worker 插件抑制尚未在真实后台会话复验。→ `docs/VALIDATION.md`
