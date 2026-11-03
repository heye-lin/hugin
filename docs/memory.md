# 记忆

后台会话不继承主会话的对话。Hugin 的记忆不是“让模型自己记住”，而是**把跨会话需要的事实写进文件，并在会话启动时注入**。证据仍然优先：记忆是上下文，不是完成凭据。

## 四层

| 层 | 位置 | 谁写 | 何时加载 | 用途 |
|---|---|---|---|---|
| 项目宪法 | `CLAUDE.md`、`.claude/hugin/PROTOCOL.md`、`.claude/rules/` | 人 / Master | 每个会话启动 | 规则、角色、门禁 |
| 项目记忆 | `.hugin/memory/` | Master | `INDEX.md` 经 `CLAUDE.md` 导入；其余按需读 | 跨 run 的决策与经验 |
| run 记忆 | `.hugin/runs/<run>/brief.md`、`memory.md` | Master | `SessionStart` hook 注入摘要 | 本次 run 的目标、约束、发现 |
| 原生 auto memory | `~/.claude/projects/<project>/memory/` | Claude | 每个会话（MEMORY.md 前 200 行 / 25KB） | Master 的个人偏好与自动笔记 |

原生 auto memory 机器本地、按 git 仓库共享（含 worktree），但**由另一个 Claude 会话启动的后台会话可能默认关闭**，所以 worker 不能依赖它。Hugin 的可靠通道是 `.hugin/memory/` + `SessionStart` hook。

## `.hugin/memory/`

```
.hugin/memory/
├── INDEX.md       # 一行一条，指向真相；≤200 行；随 CLAUDE.md 加载
├── decisions.md   # 跨 run 仍成立的决策（日期 + 链接）
├── lessons.md     # 可复用、非显而易见的经验（日期 + 来源）
└── glossary.md    # 领域术语
```

写入规则：

- 只写**不能从代码、git 历史或现有文档直接推出**的事实。
- 不写密钥、token、个人隐私、客户数据、易变日志。
- 一条一行，带日期与来源（run id、命令、ADR）。
- `INDEX.md` 是索引，不是正文；细节放专题文件，保持索引 ≤200 行。
- 过时条目删除或移到 `archive/`，不要堆积。
- 记忆与证据冲突时，以 `handoff.json`、命令输出、review/verdict 为准。

## SessionStart 注入

`.claude/hooks/session-start.mjs`（薄启动器；实现源码 `src/hooks/session-start.ts`，构建到 `dist/hooks/session-start.js`）在 `startup|resume|clear|compact|fork` 时运行，输出 `hookSpecificOutput.additionalContext`，内容包括：

- 主仓库路径（从 worktree 也能解析到主 checkout）
- 当前 run 的 `run.json` 摘要
- `brief.md`（最多 2500 字符）
- `memory.md`（最多 1200 字符）
- `board.json` 的任务状态（最多 12 条）
- `lessons.md` 最近内容（最多 1200 字符）
- 一句提醒：记忆不是证据

总输出上限 9000 字符（平台对 `additionalContext` 的硬上限是 10000 字符，超出会被截断到文件）。

`repoRoot()` 用 `git rev-parse --git-common-dir` 找主仓库；因此 worker 在 `.claude/worktrees/` 里也能读到主 checkout 的 `CURRENT_RUN`、run 证据和项目记忆。也支持 `HUGIN_RUN_DIR` / `HUGIN_REPO_ROOT` 覆盖，便于测试和迁移。

## Run 记忆

Master 在 `./bin/hugin new-run` 后写：

- `brief.md`：需求、范围、约束、验收命令、相关记忆摘录。
- `memory.md`：本次 run 的决策、踩坑、待确认项（只追加，收尾时提炼）。

派工时把 brief 的关键段落直接放进提示；不要假设 worker 会自己找到。

## 记忆提升

Run 结束、门禁通过后，Master 做一次提炼：

1. 从 handoff 的 `memory_candidates`、review findings、final-report 中挑可复用项。
2. 追加到 `.hugin/memory/lessons.md` 或 `decisions.md`。
3. 更新 `INDEX.md` 的指针；必要时合并重复条目。
4. 删除只在本次 run 成立的临时信息。
5. 不把未验证的猜测写成事实。

实现者应在 handoff 里写 `memory_candidates`：

```json
"memory_candidates": [
  {
    "text": "fixture 初始为红是设计，不要改测试断言。",
    "why": "避免下一个实现者误判。",
    "scope": "examples/fixture"
  }
]
```

## 命令

```bash
./bin/hugin memory                 # 打印 INDEX + 最近经验
./bin/hugin remember "事实..."      # 追加一条带日期的经验
./bin/hugin recall "关键词"          # 搜索 .hugin/memory 与 run 证据
```

`remember` 只写 `lessons.md`，不会自动改 INDEX；需要索引时手动加一行指针。

## 与 OMC 的映射

Master 会话可能带 OMC 插件；worker 默认关闭。两边不要各记一套：

| OMC | Hugin |
|---|---|
| `project_memory_*` | `.hugin/memory/decisions.md` + `INDEX.md` |
| `notepad_*` | `.hugin/runs/<run>/memory.md` |
| `wiki_*` | `docs/`（长期知识） |
| `remember` | `./bin/hugin remember` |

OMC 的笔记可以作为线索，但团队共享的事实以仓库文件为准。

## 可选：claude-mem

[claude-mem](https://github.com/thedotmack/claude-mem) 用 SQLite + 向量检索做会话压缩与回忆，适合在**主会话**里做增强检索。Hugin 不把它作为默认依赖：

- 它通过 hooks 和本地 worker 捕获会话；与 `worker-settings.json` 的“关闭插件”策略冲突。
- 多项目并发隔离在它的 README 中没有明确承诺。
- 引入数据库会扩大维护面，而 `.hugin/memory` 已覆盖跨 run 的稳定事实。

如要使用，建议只在 Master 侧安装：

```bash
npx claude-mem install
# 或在 Claude Code 内：
# /plugin marketplace add thedotmack/claude-mem
# /plugin install claude-mem
```

Master 用它的 `search` / `timeline` / `get_observations` 找到相关历史，把结论写进 `brief.md`；worker 仍然只读 brief 和 `.hugin/memory`。

## 参考

- Claude Code memory 文档：https://code.claude.com/docs/en/memory
- dsh-superagent-prototype：每个 work item 一个 session + 目录，证据驱动阶段，attention-first 面板。Hugin 采纳了“单写者、按证据推阶段、需要人的事项优先”的原则，但用文件而非 SQLite 作为状态源。
