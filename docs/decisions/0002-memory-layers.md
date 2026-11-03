# ADR 0002：分层文件记忆，而不是单一记忆库

- 状态：已采纳
- 日期：2026-11-03
- 相关：ADR 0001（后台会话 + 看板）

## 背景

Hugin 的 worker 是独立后台会话，不继承 Master 的对话。需要一种可靠的跨会话记忆，满足：

- worker 在 worktree 里也能读到主仓库的 run 上下文；
- 记忆不能成为“完成”的证据；
- 不引入数据库、嵌入模型或常驻服务；
- 人能直接读、改、审、diff；
- 与 OMC、claude-mem 等现有工具共存，而不是重复实现它们。

Claude Code 自带两层记忆：`CLAUDE.md` 和原生 auto memory。原生 auto memory 按 git 仓库共享（含 worktree），每个会话加载 `MEMORY.md` 前 200 行或 25KB；但**由另一个 Claude 会话启动的会话（包括后台会话）可能默认关闭 auto memory**，因此不能作为 worker 的唯一记忆通道。

## 决策

采用四层记忆：

1. **项目宪法**：`CLAUDE.md`、`.claude/hugin/PROTOCOL.md`、`.claude/rules/`，每个会话加载。
2. **项目记忆**：`.hugin/memory/`，Master 策划，`INDEX.md` 经 `CLAUDE.md` 导入，细节文件按需读。
3. **run 记忆**：`.hugin/runs/<run>/brief.md` 与 `memory.md`，由 `SessionStart` hook 注入摘要。
4. **原生 auto memory**：保留给 Master 自动记录偏好；不作为团队事实来源。

配套机制：

- `SessionStart` hook 用 `git rev-parse --git-common-dir` 解析主仓库，因此 worktree 里的 worker 也能读到主 checkout 的 run 与记忆。
- `TaskCreated` / `TaskCompleted` 的 Evidence 解析也改为以主仓库根为基准，接受相对 `.hugin/runs/...` 或主仓库内的绝对路径。
- implementer handoff 增加 `memory_candidates`；Master 在 run 结束时提炼到 `lessons.md` / `decisions.md`。
- `bin/hugin memory|remember|recall` 提供最小读写入口，不实现索引引擎。

## 后果

**收益**

- 记忆是纯文本，可 review、可 diff、可回滚。
- worker 不依赖插件或数据库；`SessionStart` 注入在所有会话一致。
- worktree 隔离不会切断证据与记忆。
- 与 OMC 的 project memory / notepad / wiki 有明确映射；claude-mem 可作为 Master 侧的可选检索增强。

**代价**

- Master 必须承担策划工作：写 brief、提炼经验、维护 INDEX、删除过时条目。
- `SessionStart` 输出有 10k 字符上限；需要截断与优先级。
- 记忆可能过时；必须在文档和提示中反复强调“证据优先”。

## 备选方案

| 方案 | 结论 |
|---|---|
| 只用原生 auto memory | 放弃：后台会话可能关闭，且不保证 worker 读到 run 上下文 |
| 只用 OMC project memory | 放弃：worker 插件被关闭；跨会话不可靠 |
| claude-mem 作为默认 | 放弃：SQLite + hooks + 常驻 worker，和 worker 的插件抑制冲突；多项目隔离未明确承诺 |
| 自建 SQLite / 向量库 | 放弃：重复造轮子，维护面大 |
| 四层文件记忆 | **采纳** |

## 参考

- Claude Code memory：https://code.claude.com/docs/en/memory
- claude-mem：https://github.com/thedotmack/claude-mem
- dsh-superagent-prototype：单写者、证据驱动阶段、attention-first 面板；Hugin 用文件而非 SQLite 承载状态。
