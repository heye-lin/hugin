# Phase 0 / Phase 1 验证记录

日期：2026-11-03
环境：Windows 11 Pro for Workstations 10.0.26300；WSL2 Ubuntu；Claude Code 2.1.317；Node 24；git。

本文件只记录**实际执行过**的检查。未执行或结果不可信的项明确标为 `UNVERIFIED`。

## 1. 环境

| 检查 | 命令 | 结果 |
|---|---|---|
| WSL2 | `grep -qi microsoft /proc/version` | VERIFIED |
| Claude Code 版本 | `claude --version` | VERIFIED：2.1.317 |
| Node | `node --version` | VERIFIED：v24.x（WSL 内通过登录 shell 可见） |
| git | `git --version` | VERIFIED |
| 代理可达 | `curl -sf -m 3 http://127.0.0.1:3425` | VERIFIED：返回非空（WSL 镜像网络） |
| `wsl.exe -e node` | 直接调用 | FAIL：node 在 nvm 下，必须 `wsl.exe -e bash -lc 'node ...'` |

结论：所有命令统一走 WSL 登录 shell（`bash -lc`），不要直接 `wsl.exe -e <tool>`。

## 2. 后台会话

| 检查 | 命令 | 结果 |
|---|---|---|
| 后台派发（已信任目录） | `claude --bg --name hugin-test "..."` | VERIFIED：在 `/home/iaeno/data/bian` 成功 |
| 状态 JSON | `claude agents --json --all` | VERIFIED：字段 `id, pid, cwd, kind, startedAt, sessionId, name, status, state`；blocked 时出现 `waitingFor` |
| 状态流转 | 轮询 | VERIFIED：`working` → `done` |
| 停止 | `claude stop <id>` | VERIFIED |
| 后台派发（本项目） | `/mnt/d/code/Hugin` | BLOCKED：Workspace not trusted |
| `--bg` 在 home 目录 | — | 拒绝：home directory is trusted one session at a time |

**结论**：架构可行，但本项目必须先人工信任一次。接受信任是交互行为，不能由脚本代做（尝试修改 `~/.claude.json` 被自动模式分类器拒绝，且不应绕过）。

## 3. tmux / Agent Teams

| 检查 | 结果 |
|---|---|
| `tmux capture-pane` 读取 Claude TUI | FAIL：返回空（alternate screen） |
| tmux server 存活 | FAIL：随后消失 |
| `--teammate-mode tmux` 分屏 | UNVERIFIED（无法确认） |

**结论**：放弃 tmux 分屏，改用后台会话 + 看板。见 [decisions/0001-background-sessions.md](decisions/0001-background-sessions.md)。

## 4. 插件干扰

| 检查 | 结果 |
|---|---|
| 后台 worker 是否加载全局 OMC | 是：测试 worker 加载了 workflow-authoring 技能并尝试走 workflow 流程 |
| `dontAsk` 模式下 AskUserQuestion | 被拒，worker 卡住 |
| 缓解 | 新增 `.claude/hugin/worker-settings.json`：关闭 ultracode、关闭 OMC/Superpowers/context7 等插件、禁止 `git push` |
| 缓解是否生效 | UNVERIFIED：需要用该 settings 实跑一个 worker 确认 |

## 5. 模型

| 检查 | 结果 |
|---|---|
| `opus` / `sonnet` / `haiku` 别名 | 经本地代理全部映射到 `opencode-go/deepseek-v4.1-flash` |
| 异族模型探测 | NOT RUN：`HUGIN_PROBE_MODELS=1` 尚未执行 |
| reviewer/verifier 模型 | 暂用 `model: inherit`；探测通过后再写完整模型 ID |

**结论**：当前审查视角的差异来自 lens 提示词，而不是模型家族。跨模型评审是后续增强项，不是当前门禁的前提。

## 6. Hooks

| 检查 | 结果 |
|---|---|
| `node --check` 语法 | VERIFIED（2026-11-04，全部 hooks + workflows + console） |
| 真实 `TaskCreated` 触发 | UNVERIFIED：需要在主会话里创建一个任务观察 |
| 缺 `AC:` 阻断 | VERIFIED：合成 stdin，exit 2 |
| 无 handoff 阻断 | VERIFIED：合成 stdin，exit 2 |
| `status: blocked` 阻断 | VERIFIED：合成 stdin，exit 2 |
| `status: complete` 放行 | VERIFIED：合成 stdin，exit 0 |
| `HUGIN_SKIP_EVIDENCE=1` | VERIFIED：逃生口放行且写 hooks.log |
| `SessionStart` 注入 | VERIFIED：1200 字符，包含 brief 与 board |
| worktree 解析主仓库 | VERIFIED：在临时 worktree 中 `repoRoot()` 返回 `/mnt/d/code/Hugin` |

官方文档已确认的 stdin 字段：`session_id`、`cwd`、`hook_event_name`、`task_id`、`task_subject`、`task_description`（可选）、`teammate_name`（可选）。解析器对 `task_description` / `description` / `task.description` 做防御性兼容。

## 7. Workflows

| 检查 | 结果 |
|---|---|
| `review-board.js` 语法 | VERIFIED（`node --check`） |
| `pre-merge-gate.js` 语法 | VERIFIED（`node --check`） |
| 预埋 bug 被 reviewer 找到 | UNVERIFIED |
| 测试失败时 gate 返回 BLOCK | UNVERIFIED |

## 8. 手动复验清单

在已信任的项目里按顺序执行：

```bash
# 1. 环境
./bin/hugin doctor
./bin/hugin doctor --quick

# 2. hook 语法
node --check .claude/hooks/lib.mjs
node --check .claude/hooks/task-created.mjs
node --check .claude/hooks/task-completed.mjs

# 3. run 初始化
./bin/hugin new-run smoke
./bin/hugin status

# 4. fixture 当前应为红
python3 -m unittest discover -s examples/fixture -v

# 5. 派一个 worker（在主会话里由 Master 执行）
claude --bg --name "hugin-smoke-T1-impl" \
  --agent hugin-implementer \
  --permission-mode acceptEdits \
  --settings .claude/hugin/worker-settings.json \
  "run=smoke task=T1 ..."

# 6. 监工
claude agents --json --all
claude logs <id>

# 7. 门禁
# 在主会话里：
# /pre-merge-gate {"runId":"smoke","base":"<base>","head":"<branch>"}
```

每项通过后，把命令、退出码、关键输出追加到本文件；未通过就保持 `UNVERIFIED`，不要改成 PASS。

## 9. 已知残余风险

- 后台会话是 research preview，`state` 取值可能变化；Master 需要容忍未知状态并回落到 `claude logs`。
- 首次信任无法自动化，部署到新机器需要人工一步。
- 项目在 `/mnt/d`（DrvFs）上，`git status` 与 worktree 操作比原生 ext4 慢；大仓库建议放 WSL home。
- 所有模型别名当前映射到同一模型，reviewer 的“独立性”有限。
- worker 的插件抑制配置尚未实跑验证。

## 10. 2026-11-04 追加验证

### 10.1 语法与门禁

```
OK   .claude/hooks/lib.mjs
OK   .claude/hooks/task-created.mjs
OK   .claude/hooks/task-completed.mjs
OK   .claude/hooks/session-start.mjs
OK   .claude/workflows/review-board.js
OK   .claude/workflows/pre-merge-gate.js
OK   lib/console.mjs
OK   bin/hugin-console.mjs
OK   web/app.js
OK   bin/hugin (bash -n)
```

Hook 合成 stdin 测试：7/7 通过（缺 AC、合法任务、越界 Evidence、缺 handoff、blocked、complete、逃生口）。

`SessionStart`：输出 1200 字符，包含 `MEMTEST_BRIEF` 与 `T1 [pending]`；在临时 worktree 中运行时 `repo: /mnt/d/code/Hugin`，证明 `--git-common-dir` 解析正确。

真实触发：2026-11-04 本会话 compact 时，hook 注入了 `Hugin memory (injected at session start)`，内容包含 `repo: D:\code\Hugin`、demo run 的 brief、board 与 lessons（1200 字符截断）。这证明 `SessionStart` 在非合成 stdin 的真实会话中生效。

### 10.2 Console

`node --test tests/console.test.mjs`：5/5 通过。

HTTP 冒烟（`./bin/hugin console --port 8790`）：

```
{"ok":true,"host":"127.0.0.1","port":8790}
GET /           200 text/html
GET /app.css    200 text/css
GET /app.js     200 text/javascript
GET /api/state  200 application/json; cache-control: no-store
GET /..%2f..%2fetc%2fpasswd  403
Content-Security-Policy: default-src 'self'; ...
```

浏览器验证（Playwright，1440×1000 与 390×844）：

- 桌面：masthead、attention 队列、stats、ledger、task detail、gate、sessions、memory 全部渲染；点击 T1 后展示 handoff、AC、review finding、verdict、residual risks、memory candidates。
- 移动端：单列布局，ledger 只保留 Task / Title / Status，无横向裁切。
- 控制台无 JS 错误或警告。
- 截图保存在 `.hugin/phase0/artifacts/`（gitignore），不随仓库提交。

### 10.3 环境

`./bin/hugin doctor --quick`：全部 PASS（WSL2、claude、node、git、repo、hooks、console、`.hugin/runs`、`claude agents --json`、worktree、proxy）。

### 10.4 仍未验证

- 项目 workspace trust：2026-11-04 再次实测，`claude --bg` 返回 `not trusted. Run claude in /mnt/d/code/Hugin once and accept the trust prompt, then retry.` 必须由人手动接受一次。
- 带 `worker-settings.json` 的真实后台 worker。
- 真实 `TaskCreated` / `TaskCompleted` 事件（目前只有合成 stdin）。
- `/review-board`、`/pre-merge-gate` 运行时行为。
- 异族模型探测。
- 原生 auto memory 在后台会话中的实际开关状态。

## 11. 2026-11-04 Windows 原生验证

背景：`ng` / `bin/hugin` 改为跨平台 Node CLI（`bin/hugin-cli.mjs`），不再强制经 WSL。

| 检查 | 命令 | 结果 |
|---|---|---|
| CLI 语法 | `node --check bin/hugin-cli.mjs` | VERIFIED |
| 环境 | `ng doctor --quick` | VERIFIED：全部 PASS（Windows、claude 2.1.317、node v24.15.0、git 2.53.0.windows.3、hooks、console、agents JSON、worktree） |
| 状态 | `ng status` | VERIFIED：`repo: D:\code\Hugin`、`run: hugin-self-iter`、`lang: zh-CN`、board 计数 |
| 语言 | `ng lang en` / `ng lang zh` | VERIFIED：`en-US` / `zh-CN`，写入 `.hugin/config.json` |
| Console | `ng console --port 8792` + `curl /` | VERIFIED：HTTP 200；`/api/state` 解析 `workers`，`workersError: null` |
| PowerShell 包装 | `.\bin\hugin.ps1 status` | VERIFIED：输出正常 |
| WSL 包装 | `wsl ... ./bin/hugin status` | VERIFIED：`repo: /mnt/d/code/Hugin`，可见 WSL 后台会话 |

未验证 / 注意：

- Windows 侧真实 `claude --bg` worker：需在 Windows 的 `ng start` 里接受 trust 后实测。
- Windows 与 WSL 的 `claude agents` 会话注册表独立；Master 与 worker 必须在同一平台。
- `ng.cmd`、Git Bash 的 `ng`、WSL 的 `~/.local/bin/ng` 都指向本仓库路径；移动仓库后需重装快捷命令。
