# 任务与证据格式

## 1. 任务描述（`TaskCreate` 的 description）

```
Goal: 一句话
AC:
- 可验证的验收标准
Files: 允许修改的文件
Evidence: .hugin/runs/<run>/tasks/<task>/handoff.json
Owner: impl-1 | review-correctness | review-security | review-tests | verify-1
Deps: T0 | none
```

硬字段：

- `AC:` 后面至少一条非空验收标准。
- `Evidence:` 必须是 `.hugin/runs/` 下的路径。
- `Owner:` 非空。

`TaskCreated` hook 缺任一字段就 `exit 2`，并把完整模板回给模型。

验收标准要能被命令或观察证明。反例：“代码质量好”。正例：“`python3 -m unittest discover -s examples/fixture -v` 退出码 0，且 `divide(1, 0)` 抛 `ZeroDivisionError`”。

## 2. Handoff（`.hugin/runs/<run>/tasks/<task>/handoff.json`）

```json
{
  "run": "20261103-fix-divide",
  "task": "T1",
  "owner": "impl-1",
  "status": "complete",
  "branch": "hugin/T1-fix-divide",
  "base": "abc1234",
  "head": "def5678",
  "files_changed": ["examples/fixture/calc.py", "examples/fixture/test_calc.py"],
  "commands_run": [
    {
      "cmd": "python3 -m unittest discover -s examples/fixture -v",
      "exit": 0,
      "log": ".hugin/runs/20261103-fix-divide/logs/T1-test.txt"
    }
  ],
  "ac": [
    {
      "criterion": "multiply(3, 4) == 12",
      "proof": "test_multiply ... ok"
    },
    {
      "criterion": "divide(1, 0) raises ZeroDivisionError",
      "proof": "test_divide_by_zero ... ok"
    }
  ],
  "residual_risks": [],
  "unverified": [],
  "memory_candidates": [
    {
      "text": "可复用的非显而易见事实",
      "why": "为什么下次需要知道",
      "scope": "路径或主题"
    }
  ],
  "created_at": "2026-11-03T12:00:00Z"
}
```

规则：

- `status` 只能是 `complete` 或 `blocked`。`TaskCompleted` 只放行 `complete`。
- `commands_run` 必须是实际运行过的命令；`exit` 用数字。
- `ac` 至少一项，且与任务里的 AC 一一对应。
- 有未验证项就写进 `unverified`，不要假装覆盖。
- 写不出证据时用 `status: "blocked"`，并说明缺什么。
- `memory_candidates` 只放跨 run 仍成立、且不能从 diff 直接看出的经验；不要放密钥、隐私或“改了什么”的复述。

## 2.1 Worktree 与 collect

后台会话（`claude --bg`）不能写共享检出，也不能写主仓库的 `.hugin/runs/`。证据流程因此分两步：

1. Master 先建隔离工作树：

   ```bash
   ./bin/hugin work <run> <task> [--base <sha>] [--branch <name>]
   ```

   默认路径 `.claude/worktrees/<run>-<task>`，默认分支 `hugin/<task>`。命令会先清理无法在本平台使用的陈旧 worktree（例如 WSL 创建、记录 `/mnt/...` gitdir 的目录），并把绝对路径写进 `.hugin/runs/<run>/tasks/<task>/worktree.txt`。

2. 在该 worktree 目录内启动 worker。worker 把 handoff 写到 **worktree 内**的 `.hugin/runs/<run>/tasks/<task>/handoff.json`。

3. worker 结束后 Master 收回证据：

   ```bash
   ./bin/hugin collect <run> <task>
   ```

   它只把 `tasks/<task>/handoff.json`（以及 handoff 里 `commands_run[].log` 引用的 `.hugin/runs/<run>/logs/` 文件）从 worktree 复制到主仓库的 `.hugin/runs/<run>/`，然后校验 handoff：`branch` 必须存在，`status` 不是 `complete` 时退出码为 1。

   它**不**回收 `reviews/` 与 `verdict.json`：实现者能写 worktree，回收会让它伪造审查结论。这两个文件由 Master 从 reviewer/verifier 的最终消息落盘。

4. `TaskCompleted` 只认主仓库里的证据文件，所以先 `collect` 再标记完成。

5. worker 不提交：在已存在的 worktree 里启动的后台会话，commit 前仍会被询问。Master 收完证据后在 worktree 里提交该分支。

reviewer / verifier 是只读角色（`Write` 禁用），把 JSON 作为最终消息返回；Master 原样落盘并在文件里记 `"staged_by": "master"`。

## 2.2 检查点台账（`.hugin/runs/<run>/checkpoints.json`）

`hugin checkpoint <run> <task> [--note <text>] [--no-push]` 在任务 worktree 里提交改动、打注解 tag `hugin/<run>/<task>`，并把结果写入 run 级台账：

```json
{
  "run": "20261103-fix-divide",
  "checkpoints": [
    {
      "task": "T1",
      "commit": "def5678...",
      "tag": "hugin/20261103-fix-divide/T1",
      "branch": "hugin/T1",
      "note": "divide by zero",
      "created_at": "2026-11-03T12:00:00.000Z",
      "pushed": false
    }
  ]
}
```

字段：

| 字段 | 含义 |
|---|---|
| `task` | 任务 id；同一任务再次 checkpoint 会覆盖该行，不重复累积 |
| `commit` | 检查点提交的完整 SHA（干净 worktree 复用当前 HEAD） |
| `tag` | 注解 tag 名，格式 `hugin/<run>/<task>`；已存在且指向其他 commit 时命令失败，不移动 tag |
| `branch` | 打检查点时 worktree 所在分支 |
| `note` | `--note` 的文本；未提供时为空字符串（提交信息回退为 `checkpoint`） |
| `created_at` | 检查点写入台账的 ISO-8601 时间 |
| `pushed` | 分支与 tag 是否都已成功推到 `origin`；`--no-push` 或推送失败时为 `false` |

推送失败只报告并保留本地检查点，命令退出码为 1。`hugin checkpoints <run> [--json]` 读取该台账；`hugin rollback <run> <task> [--branch <name>] [--dry-run]` 只创建指向 tag commit 的还原分支，不 reset、不 rebase、不覆盖已有工作区。

## 3. Review findings

`.hugin/runs/<run>/reviews/<task>-<lens>.json`：

```json
{
  "run": "20261103-fix-divide",
  "task": "T1",
  "lens": "security",
  "findings": [
    {
      "id": "SEC-1",
      "severity": "high",
      "file": "examples/fixture/calc.py",
      "line": 12,
      "claim": "divide 未处理除零",
      "evidence": "python3 -c 'from examples.fixture.calc import divide; divide(1,0)' -> ZeroDivisionError 未捕获",
      "suggestion": "显式抛 ValueError 或文档化 ZeroDivisionError"
    }
  ],
  "checked": ["输入校验", "异常路径"],
  "unverified": ["并发场景未覆盖"]
}
```

- `severity`：`critical` / `high` / `medium` / `low` / `info`。
- `evidence` 必须是能复现的命令或具体代码位置，不接受“感觉有问题”。
- reviewer 不给最终 PASS/BLOCK；裁决由门禁汇总。

lens 分工：

| lens | 关注 |
|---|---|
| `correctness` | 逻辑、边界、异常、回归 |
| `security` | 注入、路径穿越、密钥、权限、依赖 |
| `tests` | 覆盖、断言强度、脆弱测试、缺失场景 |

## 4. Verifier verdict

`.hugin/runs/<run>/reviews/<task>-verdict.json`：

```json
{
  "run": "20261103-fix-divide",
  "task": "T1",
  "verdict": "PASS",
  "checks": [
    { "cmd": "python3 -m unittest discover -s examples/fixture -v", "exit": 0, "output": "OK (5 tests)" },
    { "cmd": "git diff --stat abc1234...def5678", "exit": 0, "output": "2 files changed" }
  ],
  "ac": [
    { "criterion": "multiply(3, 4) == 12", "result": "PASS" }
  ],
  "blockers": [],
  "unverified": []
}
```

`verdict` 只能是 `PASS` / `BLOCK` / `INCOMPLETE`：

- `PASS`：命令全绿、AC 全部可证、无 blocker。
- `BLOCK`：有明确失败或高风险。
- `INCOMPLETE`：证据不足、命令没跑、环境缺失。

## 5. 命名

| 对象 | 格式 | 例子 |
|---|---|---|
| run | `YYYYMMDD-<slug>` | `20261103-fix-divide` |
| 任务 | `T<n>` | `T1`、`T2` |
| 修复任务 | `T<n>-fix<k>` | `T1-fix1` |
| 会话名 | `hugin-<run>-<task>-<role>` | `hugin-20261103-fix-divide-T1-impl` |
| 分支 | `hugin/<task>` | `hugin/T1` |
| worktree | `.claude/worktrees/<run>-<task>` | `.claude/worktrees/20261103-fix-divide-T1` |
| handoff | `.hugin/runs/<run>/tasks/<task>/handoff.json` | — |
| review | `.hugin/runs/<run>/reviews/<task>-<lens>.json` | — |
| verdict | `.hugin/runs/<run>/reviews/<task>-verdict.json` | — |

role 取值：`impl`、`review-correctness`、`review-security`、`review-tests`、`verify`。

## 6. 目录布局

```
.hugin/
├─ CURRENT_RUN
└─ runs/
   └─ <run>/
      ├─ run.json
      ├─ brief.md
      ├─ memory.md
      ├─ board.json
      ├─ hooks.log
      ├─ final-report.md
      ├─ tasks/
      │  └─ T1/handoff.json
      ├─ reviews/
      │  ├─ T1-correctness.json
      │  ├─ T1-security.json
      │  ├─ T1-tests.json
      │  ├─ T1-verdict.json
      │  ├─ review-board.json
      │  └─ gate.json
      └─ logs/
         └─ T1-test.txt
```

`.hugin/runs/*` 被 gitignore；只有 `.gitkeep` 入库。证据随 run 存活，不随分支合并。
