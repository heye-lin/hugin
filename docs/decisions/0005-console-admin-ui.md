# ADR 0005：Web 控制台改为中文管理后台（React + Ant Design）

- 状态：已采纳
- 日期：2026-11-04
- 取代：原生 HTML/CSS/JS + `editorial` 视觉风格的控制台
- 相关：ADR 0003（TypeScript + dist）

## 背景

原控制台是原生 HTML/CSS/JS，编辑杂志风、attention-first。实际使用中暴露三个问题：

1. 信息以长页面堆叠，任务、会话、run 混在一起；run 多起来后定位慢。
2. 图表/统计卡、表格分页、筛选等交互需要手写，维护成本高。
3. 界面文案中英混杂，与 zh-CN 的 run 语言不一致。

需求变成：一个**全中文的管理后台**，以概览计数、就绪队列、任务/会话/运行三张表为主，能持续轮询刷新。

## 决策

- 前端改为 **React 18.3 + Ant Design 5.29 + `@ant-design/icons` 5.6**，用 Vite 构建。
- 布局：`Layout + Sider + Menu`，四个导航：概览 / 任务 / 后台会话 / 运行记录。
- 概览：五张 `Statistic` 卡（运行中 / 队列 / 待审 / 阻塞 / 完成）+ 就绪队列表。
- 任务、会话、运行各一张 `Table`，分页、空状态、状态/阶段都用中文映射。
- 每 **3 秒** 轮询 `/api/state`；失败显示中文 `Alert` 并保留上次数据。
- 后端接口不变，`/api/state` 增加 `summary` 与 `queue`，与 `hugin status --json` 同源。
- 构建配置 `root: 'web'`、`base: './'`、`outDir: 'dist'`，产物 `web/dist/` 提交入库。
- 服务端静态资源优先 `web/dist`，缺失时回退 `web/`。

## 后果

**收益**

- 信息分层清晰：概览回答“现在有多少活、哪些可派”，表格回答“每个任务/会话/run 在哪一步”。
- 中文界面与 run 语言一致；状态枚举集中映射，避免英文泄漏。
- Ant Design 提供表格分页、空状态、响应式栅格，减少自维护 CSS。
- 轮询实现简单，不需要 WebSocket；只读服务端无需改协议。

**代价**

- bundle 约 1 MB（antd + React），首次加载变重；对内网只读看板可接受。
- Ant Design 5 的 CSS-in-JS 在运行时注入 `<style>`，CSP 必须允许 `style-src 'unsafe-inline'`；脚本与网络请求仍限 `'self'`。
- 前端需要 `npm run build-web`；`web/dist/` 与源码必须同步提交。
- 原 `editorial` skill 不再是控制台依赖，仅作为历史视觉素材保留。

## 备选方案

| 方案 | 结论 |
|---|---|
| 继续原生 HTML/CSS/JS | 放弃：表格/分页/响应式维护成本高，信息层级不清 |
| 服务端渲染模板 | 放弃：仍要手写交互，轮询体验差 |
| 引入完整后台框架（Next/Nuxt） | 放弃：过重，控制台是单页只读视图 |
| React + Ant Design + Vite | **采纳** |
