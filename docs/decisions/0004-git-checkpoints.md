# ADR 0004：用 git 提交 + 注解 tag 作为任务检查点

- 状态：已采纳
- 日期：2026-11-04
- 相关：ADR 0003（TypeScript + dist）

## 背景

Hugin 的每个任务在独立 worktree 中完成，Master 收完证据后需要留下一个可追溯、可回退的节点。需要同时满足：

- 每个任务有唯一、可引用的提交点；
- 能从一个 run 的任意任务点恢复代码，但不破坏已有分支；
- 回退操作必须是可审计、非破坏性的；
- 不引入额外服务或数据库，台账仍是纯文本。

## 决策

引入三个命令，实现在 `src/lib/checkpoints.ts`：

1. `hugin checkpoint <run> <task> [--note <text>] [--no-push]`
   - 在任务的 worktree 里 `git add -A` + `git commit`（干净 worktree 复用 HEAD）；
   - 打注解 tag `hugin/<run>/<task>`；
   - 追加/覆盖 `.hugin/runs/<run>/checkpoints.json` 台账（同一 task 覆盖，不重复累积）；
   - 默认 push 分支与 tag，失败只报告并保留本地检查点，退出码 1。
2. `hugin checkpoints <run> [--json]`：读取台账，文本或 JSON 输出。
3. `hugin rollback <run> <task> [--branch <name>] [--dry-run]`
   - 只创建（或复用）指向 tag commit 的还原分支，默认 `restore/<run>/<task>-<时间戳>`；
   - 不 reset、不 rebase、不覆盖已有 checkout；
   - 拒绝脏工作区，拒绝从 main/master 执行；
   - 已存在同名分支且指向不同 commit 时失败。

安全约束：

- 只允许在 `.claude/worktrees/` 下、分支匹配 `hugin/<task>` 或 handoff 声明的分支上 checkpoint；
- tag 已存在且指向其他 commit 时**不移动 tag**，直接失败；
- run/task 名称走白名单校验，防止路径逃逸。

## 后果

**收益**

- 每个任务有 commit + 注解 tag + 台账三份可交叉核对的记录。
- `rollback --dry-run` 可以在不动工作区的前提下确认还原点；正式回退只新增分支。
- 台账是 JSON，终端、控制台、未来工具都能读；不依赖 git 私有格式。
- 默认 push 让远程也留有检查点；`--no-push` 支持离线/评审场景。

**代价**

- checkpoint 会移动分支（提交未提交改动）；worker 必须保持“不提交、不 push”，由 Master 执行。
- 默认 push 需要 `origin` 可用；没有远程时用 `--no-push`，否则命令返回 1（本地检查点仍保留）。
- 同一 task 的 tag 不可复用指向新 commit；需要新检查点时任务 id 必须区分（如 `T1-fix1`）。

## 备选方案

| 方案 | 结论 |
|---|---|
| 只靠 `git commit`，不打 tag | 放弃：无法从 run 级稳定引用某个任务的检查点 |
| `git reset --hard` 回退 | 放弃：破坏性，容易丢未提交工作 |
| `git rebase` 到历史点 | 放弃：重写历史，影响其他分支 |
| 复制目录做快照 | 放弃：体积大、不可 diff、与 git 脱节 |
| commit + 注解 tag + 台账 + 非破坏 rollback | **采纳** |
