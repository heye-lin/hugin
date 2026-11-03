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
| 分支 | `hugin/<task>-<slug>` | `hugin/T1-fix-divide` |
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
