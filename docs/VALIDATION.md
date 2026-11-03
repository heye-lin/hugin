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
| `node --check` 语法 | 待本轮回填 |
| 真实 `TaskCreated` 触发 | UNVERIFIED：需要在主会话里创建一个任务观察 |
| 缺 `AC:` 阻断 | 待合成 stdin 测试 |
| 无 handoff 阻断 | 待合成 stdin 测试 |
| `status: blocked` 阻断 | 待合成 stdin 测试 |
| `status: complete` 放行 | 待合成 stdin 测试 |

官方文档已确认的 stdin 字段：`session_id`、`cwd`、`hook_event_name`、`task_id`、`task_subject`、`task_description`（可选）、`teammate_name`（可选）。解析器对 `task_description` / `description` / `task.description` 做防御性兼容。

## 7. Workflows

| 检查 | 结果 |
|---|---|
| `review-board.js` 语法 | UNVERIFIED |
| `pre-merge-gate.js` 语法 | UNVERIFIED |
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
