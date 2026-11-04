# Hugin 控制台

中文管理后台：把 `.hugin/runs/` 的任务、证据、审查、门禁，以及 `claude agents` 的后台会话，放进一个只读的 React + Ant Design 页面。

## 启动

```bash
./bin/hugin console                    # 前台，http://127.0.0.1:8787
./bin/hugin console --port 8790
./bin/hugin console --status           # 是否在跑、pid、url
./bin/hugin console --stop             # 停止后台控制台
```

`hugin start` 默认在后台启动控制台（`ensureConsole`）：pid 写 `.hugin/console.pid`，日志写 `.hugin/logs/console.log`，用 `/healthz` 健康检查并防重复；已在健康运行则复用。`--no-console` 跳过，`--port` / `HUGIN_CONSOLE_PORT` 默认 8787。

默认只绑定 `127.0.0.1`，不提供远程访问、不写入任何文件、不需要登录。`--host` 只接受 `127.0.0.1` 或 `localhost`。

## 页面结构

左侧 Sider 四个入口，右上角显示当前运行、运行状态、语言、控制台在线状态与最近刷新时间：

| 导航 | 内容 |
|---|---|
| 概览 | 五张统计卡（运行中 / 队列 / 待审 / 阻塞 / 完成）+ 就绪队列表（任务、标题、负责人、依赖） |
| 任务 | 任务表：任务、标题、负责人、阶段、状态、依赖、工作会话、证据、等待原因 |
| 后台会话 | 所有 `hugin-*` 后台会话：ID、名称、状态、等待原因 |
| 运行记录 | run 列表：运行、状态、base、创建时间；当前 run 带“当前”标记 |

数据每 **3 秒** 轮询一次 `/api/state`。上一轮请求未返回时跳过本轮，避免请求堆积；组件卸载时通过 `AbortController` 中止并忽略迟到的响应。请求失败时顶部显示中文 Alert“无法连接控制台服务，正在重试…”，并保留上一次成功的数据；首次加载显示“正在加载控制台数据…”。

阶段（stage）由证据推导，而不是照抄内部状态；前端把 stage 与状态枚举翻成中文：

| stage | 条件 | 中文标签 |
|---|---|---|
| `attention` | 匹配到的 worker 为 `blocked` | 需处理 |
| `failed` | worker 或任务 `failed` | 失败 |
| `blocked` | 任务/handoff 为 `blocked` | 阻塞 |
| `complete` | handoff `complete` + verdict `PASS` + 无 open finding | 完成 |
| `review` | handoff `complete`，但有 open finding 或未验收；或 board 明确标 `review` | 待审 |
| `working` | worker `working` 或任务 `dispatched` | 进行中 |
| `queued` | 其他 | 排队 |

## API

| 路径 | 返回 |
|---|---|
| `GET /healthz` | `{ok:true, host, port}` |
| `GET /api/runs` | `{runs:[{id, base, status, createdAt}]}` |
| `GET /api/state?run=<id>` | 页面所需的全部状态；缺省用 `CURRENT_RUN`。含 `summary`、`queue`、`tasks`、`workers`、`workersError` |
| `GET /`、`/assets/*` | 静态资源（`web/dist`，未构建时回退 `web/`） |

`summary` 与 `hugin status --json` 的 `counts` 同源：

```json
{
  "running": 2,
  "queued": 1,
  "review": 1,
  "blocked": 0,
  "complete": 3
}
```

- `running`：本 run（`hugin-<run>-*`）中 state 为 `working` 的会话数；
- `queued`：`board.json` 中 `pending` 且依赖全部完成的任务，按 board 顺序放进 `queue`（review/complete 任务已先归入对应桶，不会重复计入）；
- `review`：stage 为 `review` 的任务（handoff `complete` 但 verdict 不是 `PASS`/有 open finding，或 board 明确标 `review`）；
- `blocked`：本 run 中 state 为 `blocked` 的会话数；
- `complete`：stage 为 `complete` 的任务（handoff `complete` + verdict `PASS` + 无 open finding）。

计数与任务表的 stage 同源：每个任务只落进一个桶。**board 标 `complete` 本身不算完成**——只有 handoff 与 verdict 满足 complete 条件时，stage 才是 `complete`；否则按实际 stage 计入 `review` 或保持 `queued`。若同一任务同时出现在两个计数里，即为 bug。

只允许 `GET` / `HEAD`。所有响应 `Cache-Control: no-store`（API）或 `no-cache`（静态）；带 CSP、`nosniff`、`no-referrer`。静态文件限定在 `web/dist`（或回退的 `web/`）下，路径穿越返回 403。

`/api/state` 会调用 `claude agents --json --all`，5 秒超时；失败时把错误放进 `workersError`，页面仍能显示文件状态。

## 前端构建

前端源码在 `web/src/`（React 18.3、Ant Design 5.29、`@ant-design/icons`），Vite 配置 `root: 'web'`、`base: './'`、`outDir: 'dist'`，产物落在 `web/dist/` 并提交入库。改前端后运行：

```bash
npm run build-web     # vite build
npm run build         # TS + 前端
```

服务端 `serveStatic` 优先 `web/dist`，只有它缺失时才回退到 `web/`，因此正常部署必须带上构建产物。

## CSP 与 antd

静态响应的 CSP：

```text
default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'
```

`style-src` 必须允许 `'unsafe-inline'`：Ant Design 5 使用 CSS-in-JS，运行时注入 `<style>` 标签，不放行会导致样式整体丢失。脚本仍只允许 `'self'`；不加载外部字体、脚本、图片。

## 数据来源

- `.hugin/runs/<run>/run.json`、`board.json`、`brief.md`、`memory.md`、`final-report.md`
- `tasks/<task>/handoff.json`
- `reviews/<task>-<lens>.json`、`reviews/<task>-verdict.json`（规范路径；`tasks/<task>/verdict.json` 与 `reviews/<task>-verify.json` 作为旧兼容回退）
- `reviews/gate.json`、`reviews/review-board.json`
- `.hugin/memory/INDEX.md`、`lessons.md`
- `claude agents --json --all`

没有 board 时，会扫描 `tasks/*/handoff.json` 推断任务；没有 handoff 的任务显示“缺少 handoff”。

## 安全

- 只读：没有任何写接口或命令执行接口。
- 绑定 loopback；拒绝非回环 host。
- 文件内容全部作为文本渲染，不执行、不拼接 HTML。
- 不展示 `.env`、`.ssh` 等敏感文件；只读取 `.hugin/` 和 `web/`。
- CSP 的 `style-src 'unsafe-inline'` 仅服务于 antd 的运行时样式；脚本与网络请求仍限 `'self'`。

## 测试

```bash
node --test dist/tests/console.test.js
```

覆盖：run 列表、任务/证据/review/verdict 解析、blocked worker 的 attention、`workersError`、summary/queue、HTTP API、`no-store`、路径穿越拦截、`web/dist` 与回退、antd 内联样式放行、pidfile 防重复与陈旧清理。

手工冒烟：

```bash
./bin/hugin console --port 8790
curl -s http://127.0.0.1:8790/healthz
curl -s http://127.0.0.1:8790/api/state
```

## 参考

- dsh-superagent-prototype 的面板原则：概览计数 → 就绪队列 → 明细表；阶段由证据推导，计数可核查。
- 本项目的实现是只读文件视图，不引入 SQLite、任务队列或独立调度器。
