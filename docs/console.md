# Hugin Console

本地只读看板：把 `.hugin/runs/` 的任务、证据、审查、门禁，以及 `claude agents` 的后台会话，放在一张“编辑杂志风”的页面上。

## 启动

```bash
./bin/hugin console                 # http://127.0.0.1:8787
./bin/hugin console --port 8790
```

默认只绑定 `127.0.0.1`，不提供远程访问、不写入任何文件、不需要登录。`--host` 只接受 `127.0.0.1` 或 `localhost`。

## 页面结构

参考 dsh-superagent-prototype 的优先级：**先回答“现在需要人做什么”，再回答“系统是否健康”，最后才是历史**。

1. **Needs Attention**：blocked / failed 会话、blocked / failed 任务、open findings、gate BLOCK、`claude agents` 不可用。
2. **Stats**：任务数、已完成、阻塞、open findings、attention 数。
3. **Task Ledger**：任务、标题、owner、阶段、证据状态。点击行展开详情。
4. **Task Detail**：范围、handoff、验收、verifier、review findings、残余风险、记忆候选、建议动作。
5. **Gate**：`gate.json` 与 `review-board.json` 的结论、理由、残余风险。
6. **Sessions**：所有 `hugin-*` 后台会话的 state 与 `waitingFor`。
7. **Memory**：项目记忆索引与最近经验。

阶段（stage）由证据推导，而不是照抄内部状态：

| stage | 条件 | 建议动作 |
|---|---|---|
| `attention` | 匹配到的 worker 为 `blocked` | `./bin/hugin attach <id>` |
| `failed` | worker 或任务 `failed` | `./bin/hugin logs <id>` |
| `blocked` | 任务/handoff 为 `blocked` | 先解除阻塞，再重派 |
| `complete` | handoff `complete` + verdict `PASS` + 无 open finding | 交给人决定是否合并 |
| `review` | handoff `complete`，但有 open finding 或未验收 | 检查 findings / 派 reviewer |
| `working` | worker `working` 或任务 `dispatched` | 继续监工 |
| `queued` | 其他 | 派实现者 |

## API

| 路径 | 返回 |
|---|---|
| `GET /healthz` | `{ok:true}` |
| `GET /api/runs` | run 列表（id、base、status、createdAt） |
| `GET /api/state?run=<id>` | 页面所需的全部状态；缺省用 `CURRENT_RUN` |
| `GET /`、`/app.css`、`/app.js` | 静态资源 |

只允许 `GET` / `HEAD`。所有响应 `Cache-Control: no-store`（API）或 `no-cache`（静态）；带 CSP、`nosniff`、`no-referrer`。静态文件限定在 `web/` 下，路径穿越返回 403。

`/api/state` 会调用 `claude agents --json --all`，5 秒超时；失败时把错误放进 `workersError`，页面仍能显示文件状态。

## 数据来源

- `.hugin/runs/<run>/run.json`、`board.json`、`brief.md`、`memory.md`、`final-report.md`
- `tasks/<task>/handoff.json`、`tasks/<task>/verdict.json`
- `reviews/<task>-<lens>.json`、`reviews/<task>-verdict.json`
- `reviews/gate.json`、`reviews/review-board.json`
- `.hugin/memory/INDEX.md`、`lessons.md`
- `claude agents --json --all`

没有 board 时，会扫描 `tasks/*/handoff.json` 推断任务；没有 handoff 的任务显示 `handoff missing`。

## 视觉

使用项目内安装的 `editorial` skill（来源：`editorial-style-pack`）：

- 暖米色 `#F9F8F6`、柔黑 `#1C1C1C`、纯单色
- 衬线标题、无衬线正文、1px 细线、零圆角、零阴影
- 大写小字标签、`letter-spacing` 0.2em
- 禁止彩色强调、渐变、圆角、阴影
- 移动端单列，表格只保留任务/标题/阶段；详情按需展开

样式文件：`web/app.css`；skill 与 tokens：`.claude/skills/editorial/`。

## 安全

- 只读：没有任何写接口或命令执行接口。
- 绑定 loopback；拒绝非回环 host。
- 前端不用 `innerHTML` 渲染文件内容，全部 `textContent`。
- 不加载外部字体、脚本、图片；CSP 只允许 `'self'`。
- 不展示 `.env`、`.ssh` 等敏感文件；只读取 `.hugin/` 和 `web/`。

## 测试

```bash
node --test tests/console.test.mjs
```

覆盖：run 列表、任务/证据/review/verdict 解析、blocked worker 的 attention、`workersError`、HTTP API、`no-store`、路径穿越拦截。

手工冒烟：

```bash
./bin/hugin console --port 8790 &
curl -s http://127.0.0.1:8790/healthz
curl -s http://127.0.0.1:8790/api/state | head -c 500
```

## 参考

- dsh-superagent-prototype 的面板原则：attention-first、summary → detail、可核查的互斥状态、诚实计数、健康状态安静、操作贴近问题。
- 本项目的实现是只读文件视图，不引入 SQLite、任务队列或独立调度器。
