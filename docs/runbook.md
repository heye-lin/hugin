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

### 构建与测试

源码是 TypeScript（`src/`），产物 `dist/` 与 `web/dist/` 都提交入库。拉取代码后先装依赖；改过源码必须重新构建：

```bash
npm install
npm run build                        # tsc + vite build
npm test                             # build-ts 后跑 dist/tests/*.test.js
node --test dist/tests/*.test.js     # 不重新构建
```

`doctor --quick` 会检查 `dist/cli/main.js`、`dist/hooks/*.js`、`bin/*.mjs` 与 `web/dist` 是否存在并可解析。

## 1. 启动

两个窗口：

```bash
# Window 1
ng start

# Window 2
ng dashboard
```

Windows 与 WSL 都可以；但 Master 和 worker 必须在同一平台。不要用 Windows 的 Master 去 attach WSL 的后台会话，反之亦然。

`ng start` 默认在后台启动只读 Web 控制台（`http://127.0.0.1:8787`），pid 写 `.hugin/console.pid`，日志写 `.hugin/logs/console.log`；已在健康运行则复用，不会重复启动。`--no-console` 跳过，`--port N` 或 `HUGIN_CONSOLE_PORT` 改端口：

```bash
ng console --status   # 是否在跑、pid、url
ng console --stop     # 停止后台控制台
```

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

同一时间只派一个实现任务。后台会话不能写共享检出，也不能写主仓库的 `.hugin/runs/`，所以先建隔离 worktree，再在它里面启动 worker：

```bash
ng work <run> T1 --base <base-commit>     # 打印 worktree 绝对路径
cd <worktree-path>
claude --bg --name "hugin-<run>-T1-impl" \
  --agent hugin-implementer \
  --permission-mode acceptEdits \
  --settings .claude/hugin/worker-settings.json \
  "run=<run> task=T1
Goal: ...
AC:
- ...
Files: examples/fixture/calc.py, examples/fixture/test_calc.py
Evidence: <worktree-path>/.hugin/runs/<run>/tasks/T1/handoff.json
Base: <base-commit>
Brief: <repo-root>/.hugin/runs/<run>/brief.md
Verify: python -m unittest discover -s examples/fixture -v   # Windows；WSL 用 python3
只做这个任务。完成后把 handoff 写进 worktree，不要提交、不要标记完成，并包含 memory_candidates。"
```

worker `done` 之后：

```bash
ng collect <run> T1                          # 只收 handoff 与 commands_run[].log 引用的日志
ng checkpoint <run> T1 --note "divide by zero"   # 提交 worktree、打注解 tag、写台账
```

`collect` 会校验 `run` / `task` 与命令参数一致、`ac` 非空、handoff 声明的 `head`/`commit` 与 worktree HEAD 一致，失败退出码 1；成功后写 `tasks/T1/collected.json`。日志必须以 `T1-` 开头、不超过 5 MB，目标已存在且内容不同时不覆盖。它**不**收回 review/verdict。

`checkpoint` 默认把分支与 tag `hugin/<run>/<task>` 推到 `origin`；不想推就加 `--no-push`。台账在 `.hugin/runs/<run>/checkpoints.json`。

要点：

- 提示必须自包含（子会话看不到主会话上下文）。
- `--name` 必须符合 `hugin-<run>-<task>-<role>`。
- 必须带 `--settings .claude/hugin/worker-settings.json`，否则会加载全局 OMC 插件。
- Master 与 worker 必须同平台；worktree 也必须在同一平台创建。
- worker 用纯 `git status` / `git diff` / `git log`（cwd 就是 worktree）；`-C` 形式只在只读子命令的 allow 规则内。
- 不要加 `--dangerously-skip-permissions`。

## 5. 监工

```bash
claude agents --json --all
ng status                  # 默认隐藏 stopped 会话；含 counts 与就绪队列
ng status --all            # 包含已停止会话
ng status --json           # {repo,run,language,counts,queue,tasks,workers,console}
ng status --watch [--interval N]   # 默认每 5 秒清屏重绘；Ctrl-C 退出 0
ng console --status        # 后台控制台是否在跑
ng console                 # 前台启动只读控制台（127.0.0.1:8787）
```

`counts` 的 `running` 来自本 run `hugin-<run>-*` 且 state=`working` 的会话；`queued` 是 pending 且依赖已完成的就绪任务，按 board 顺序；`review` 是 handoff complete 但未 PASS。`ng console --stop` 停止后台控制台；它不写文件，也不替你处理权限。

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
  "lens=correctness。审查 <base>...<branch>。只读。把 findings JSON 作为最终消息返回（Write 已禁用），由 Master 落盘到 .hugin/runs/<run>/reviews/T1-correctness.json。"

claude --bg --name "hugin-<run>-T1-review-security" --agent hugin-reviewer \
  --permission-mode acceptEdits --settings .claude/hugin/worker-settings.json \
  "lens=security。审查 <base>...<branch>。只读。把 findings JSON 作为最终消息返回（Write 已禁用），由 Master 落盘到 .hugin/runs/<run>/reviews/T1-security.json。"

claude --bg --name "hugin-<run>-T1-review-tests" --agent hugin-reviewer \
  --permission-mode acceptEdits --settings .claude/hugin/worker-settings.json \
  "lens=tests。审查 <base>...<branch>。只读。把 findings JSON 作为最终消息返回（Write 已禁用），由 Master 落盘到 .hugin/runs/<run>/reviews/T1-tests.json。"
```

三个都 `done` 后：

```bash
claude --bg --name "hugin-<run>-T1-verify" --agent hugin-verifier \
  --permission-mode acceptEdits --settings .claude/hugin/worker-settings.json \
  "独立复跑 <base>...<branch> 的验证命令，核对 handoff AC。只读。把 verdict JSON 作为最终消息返回（Write 已禁用），由 Master 落盘到 .hugin/runs/<run>/reviews/T1-verdict.json。"
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

检查点：

```bash
ng checkpoints <run>              # 台账：task / commit / tag / 时间 / pushed|local
ng checkpoints <run> --json
ng rollback <run> T1 --dry-run    # 只打印将创建的还原分支
ng rollback <run> T1              # 建/切到 restore/<run>/<task>-<时间戳>
```

`rollback` 只创建或切换到指向 tag commit 的还原分支，不 reset、不 rebase；拒绝脏工作区和 main/master。已有同名分支且指向不同 commit 时直接失败。

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
ng status --watch
cat .hugin/runs/<run>/run.json
cat .hugin/runs/<run>/board.json
cat .hugin/runs/<run>/checkpoints.json
ls .hugin/runs/<run>/tasks/*/handoff.json
ls .hugin/runs/<run>/tasks/*/collected.json
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

写到 **worktree 内**的 `.hugin/runs/<run>/tasks/<task>/handoff.json`。后台会话不能写主仓库的 `.hugin/runs/`；worker 结束后由 Master 运行 `ng collect <run> <task>` 收回到主仓库，hook 校验的是主仓库那份。`collect` 之前标记完成一定被阻断。

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
