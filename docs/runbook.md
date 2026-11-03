# 操作手册

所有命令都在项目根目录执行；Windows PowerShell 与 WSL 都支持，统一用 `ng`（等价于 `./bin/hugin`）。两侧后台会话注册表独立，不要混用。

## 0. 开工前

```bash
ng doctor          # 全量检查
ng doctor --quick  # 跳过耗时项
```

`FAIL` 的常见原因：

| 失败项 | 处理 |
|---|---|
| `inside a git repository` | `git init && git add -A && git commit -m "init"` |
| `claude agents JSON` | 升级 Claude Code；确认 `claude agents --json` 单跑可用 |
| `proxy 127.0.0.1:3425` | 仅 WSL 检查；启动本地代理，WSL 需镜像网络 |
| `.hugin/runs writable` | `mkdir -p .hugin/runs && chmod u+w .hugin/runs` |
| 其他 `claude` 检查 | 在所用平台用 `command -v claude`（WSL）或 `where claude`（Windows）确认 PATH |

## 1. 启动

两个窗口：

```bash
# Window 1
ng start

# Window 2
ng dashboard
```

Windows 与 WSL 都可以；但 Master 和 worker 必须在同一平台。不要用 Windows 的 Master 去 attach WSL 的后台会话，反之亦然。

## 2. 建 run

```bash
ng new-run              # 用时间戳
ng new-run 20261103-fix-divide
```

产物：

```
.hugin/runs/<run>/
├─ run.json          # run、base commit、created_at、status
├─ brief.md          # 本次 run 的目标、范围、约束、验收命令
├─ memory.md         # 本次 run 的决策与踩坑（可追加）
├─ board.json
├─ tasks/
├─ reviews/
└─ logs/
.hugin/CURRENT_RUN   # hooks 用它定位当前 run
```

建完 run 先写 `brief.md`。`SessionStart` hook 会把它注入每个 worker；派工提示里仍要带关键段落。生成本次 run 前先读 `.hugin/memory/INDEX.md` 和相关 `lessons.md`，把适用条目摘进 brief。

## 3. 写任务板

Master 在 `.hugin/runs/<run>/board.json` 维护：

```json
{
  "run": "20261103-fix-divide",
  "base": "abc1234",
  "tasks": [
    {
      "id": "T1",
      "owner": "impl-1",
      "status": "pending",
      "goal": "修复 multiply 并实现 divide",
      "files": ["examples/fixture/calc.py", "examples/fixture/test_calc.py"],
      "evidence": ".hugin/runs/20261103-fix-divide/tasks/T1/handoff.json",
      "deps": []
    }
  ]
}
```

状态：`pending` → `dispatched` → `working` → `done` / `blocked` / `failed`。
Master 是唯一写者。

## 4. 派 implementer

同一时间只派一个实现任务。

```bash
claude --bg --name "hugin-<run>-T1-impl" \
  --agent hugin-implementer \
  --permission-mode acceptEdits \
  --settings .claude/hugin/worker-settings.json \
  "run=<run> task=T1
Goal: ...
AC:
- ...
Files: examples/fixture/calc.py, examples/fixture/test_calc.py
Evidence: .hugin/runs/<run>/tasks/T1/handoff.json
Base: <base-commit>
Brief: .hugin/runs/<run>/brief.md
Verify: python3 -m unittest discover -s examples/fixture -v
只做这个任务。完成后写 handoff，并包含 memory_candidates。"
```

要点：

- 提示必须自包含（子会话看不到主会话上下文）。
- `--name` 必须符合 `hugin-<run>-<task>-<role>`。
- 必须带 `--settings .claude/hugin/worker-settings.json`，否则会加载全局 OMC 插件。
- 不要加 `--dangerously-skip-permissions`。

## 5. 监工

```bash
claude agents --json --all
ng status        # 默认隐藏 stopped 会话
ng status --all  # 包含已停止会话
ng console      # 只读 Web 看板；同一份文件状态 + attention 队列
```

`ng console` 默认监听 `127.0.0.1:8787`；它不写文件，也不替你处理权限。

只看本次 run：

```bash
claude agents --json --all | jq -r '.[] | select(.name | startswith("hugin-<run>-")) | [.id,.state,.name,.waitingFor] | @tsv'
```

状态处理：

| state | 动作 |
|---|---|
| `working` | 继续等；不要重复派同一任务 |
| `blocked` | 读 `waitingFor`；让用户 `ng attach <id>` 处理，或拆更小的任务重派 |
| `done` | 读 handoff，核对 `status`、`commands_run`、`ac` |
| `failed` | `ng logs <id>` 看原因；修提示后重派，最多 3 次 |
| `stopped` | 确认是人停的还是异常；需要就 `claude respawn <id>` 或重派 |

轮询节奏：至少间隔 30–60 秒，不要紧循环。

## 6. 派 reviewer / verifier

实现任务 `done` 且 handoff 合格后，三个 lens 并行：

```bash
claude --bg --name "hugin-<run>-T1-review-correctness" --agent hugin-reviewer \
  --permission-mode acceptEdits --settings .claude/hugin/worker-settings.json \
  "lens=correctness。审查 <base>..<branch>。只读。findings 写到 .hugin/runs/<run>/reviews/T1-correctness.json。"

claude --bg --name "hugin-<run>-T1-review-security" --agent hugin-reviewer \
  --permission-mode acceptEdits --settings .claude/hugin/worker-settings.json \
  "lens=security。审查 <base>..<branch>。只读。findings 写到 .hugin/runs/<run>/reviews/T1-security.json。"

claude --bg --name "hugin-<run>-T1-review-tests" --agent hugin-reviewer \
  --permission-mode acceptEdits --settings .claude/hugin/worker-settings.json \
  "lens=tests。审查 <base>..<branch>。只读。findings 写到 .hugin/runs/<run>/reviews/T1-tests.json。"
```

三个都 `done` 后：

```bash
claude --bg --name "hugin-<run>-T1-verify" --agent hugin-verifier \
  --permission-mode acceptEdits --settings .claude/hugin/worker-settings.json \
  "独立复跑 <base>..<branch> 的验证命令，核对 handoff AC。只读。verdict 写到 .hugin/runs/<run>/reviews/T1-verdict.json。"
```

## 7. 严格门禁（可选）

在主会话里：

```text
/review-board {"runId":"<run>","base":"<base>","head":"<branch>"}
```

```text
/pre-merge-gate {"runId":"<run>","base":"<base>","head":"<branch>","testCommand":"python3 -m unittest discover -s examples/fixture -v"}
```

workflow 不能写文件；把返回 JSON 原样写入：

- `.hugin/runs/<run>/reviews/review-board.json`
- `.hugin/runs/<run>/reviews/gate.json`

## 8. 修复循环

BLOCK 时：

1. 从 findings 里挑 `severity: high|critical` 和有复现证据的项。
2. 建修复任务（`T1-fix1`），写清 finding id 与复现命令。
3. 重派 implementer；重跑 review/verify。
4. 最多 3 轮；仍 BLOCK 就停下向人汇报，不硬合并。

## 9. 收尾

写 `.hugin/runs/<run>/final-report.md`，必须包含：

- 需求与范围
- 任务表与最终状态
- 每个门禁的实际命令和原始输出摘要
- findings 与处理结果
- 残余风险
- 未验证项
- 分支与 commit

然后提炼记忆：

1. 汇总 handoff 的 `memory_candidates`、反复出现的 finding、非显而易见的修复。
2. 可复用经验追加到 `.hugin/memory/lessons.md`；长期决策写 `decisions.md`。
3. 更新 `INDEX.md` 指针；删除过时条目，保持 200 行以内。
4. 不写密钥、隐私、易变日志或未经证实的猜测。

```bash
ng memory          # 检查索引与最近经验
ng recall "关键词"  # 确认没有重复条目
```

然后：

```bash
claude stop <id>   # 停止仍在跑的 worker（如果有）
```

合并由人决定：

```bash
git log --oneline <base>..<branch>
git diff <base>...<branch>
git merge --no-ff <branch>
```

## 10. 恢复

Master 重启后：

```bash
ng status
cat .hugin/runs/<run>/run.json
cat .hugin/runs/<run>/board.json
ls .hugin/runs/<run>/tasks/*/handoff.json
claude agents --json --all
```

以文件为准重建任务状态；正在 `working` 的 worker 可以继续等，`blocked` 的按第 5 节处理。

单个 worker 想继续对话：

```bash
claude --resume <sessionId>
```

`sessionId` 来自 `claude agents --json --all`。

## 11. 常见问题

**`claude --bg` 报 Workspace not trusted**

在该目录手动 `claude` 一次，接受信任对话框。不要用脚本改 `~/.claude.json`。

**worker 跑偏，去加载插件/工作流**

确认派工时带了 `--settings .claude/hugin/worker-settings.json`。

**worker 改了主检出**

后台会话应在 `.claude/worktrees/` 下工作；如果 `git status` 显示主检出被改，先停 worker，`git diff` 核对，再决定是否恢复。不要盲目 `git checkout -- .`。

**hook 一直阻断**

看 `.hugin/runs/<run>/hooks.log`。确认任务描述里有 `AC:`、`Evidence:`、`Owner:`，且 Evidence 指向的文件存在、`status` 为 `complete`。
临时逃生口：`HUGIN_SKIP_EVIDENCE=1`（只用于初始化/迁移，事后补 handoff）。

**worker 在 worktree 里，handoff 写到哪**

hook 用 `git rev-parse --git-common-dir` 找到主仓库，Evidence 的相对路径按主仓库解析，所以写 `.hugin/runs/<run>/...` 即可，不会落到 worktree 的 `.hugin/`。如果设置了 `HUGIN_RUN_DIR`，确认它指向主仓库下的 run 目录，而不是旧的测试 run。

**SessionStart 注入的内容不对**

检查 `.hugin/CURRENT_RUN` 是否指向想看的 run；hook 读取 `repoRoot` 下的 `CURRENT_RUN`、run `brief.md`/`memory.md`/`board.json` 和 `.hugin/memory/lessons.md`。用 `ng status` 和 `ng memory` 对照。

**reviewer 说没有权限写 findings**

reviewer 是只读的，findings 应通过 stdout 返回，由 Master 落盘；或让 reviewer 用 Bash heredoc 写文件（Bash 在其工具白名单内）。推荐 Master 落盘。

## 12. 成本控制

- 一次 run 默认 1 个 implementer + 3 个 reviewer + 1 个 verifier。
- 实现任务串行，避免重复劳动。
- 不在 worker 上开 ultracode。
- 小改动可以只跑 correctness + tests 两个 lens。
- 用 `/usage` 观察消耗。
