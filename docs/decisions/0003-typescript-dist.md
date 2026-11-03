# ADR 0003：TypeScript 源码 + 提交 dist/ 构建产物

- 状态：已采纳
- 日期：2026-11-04
- 相关：ADR 0001（后台会话 + 看板）

## 背景

Hugin 早期全部用 `.mjs` 实现：CLI、console 后端、hooks、测试都是手写 JavaScript。规模变大后出现三个问题：

1. 状态对象（`ConsoleState`、`Task`、`handoff`、`checkpoint` 台账）字段多且跨文件流转，缺少类型检查，改一个字段全靠测试兜底。
2. hook 与 CLI 共享路径解析、run/task 校验、证据读取逻辑，复制粘贴容易漂移。
3. 测试直接跑 `.mjs`，无法在编译期发现签名不一致。

同时有两个硬约束：

- hooks 由 Claude Code 直接以 `node .claude/hooks/*.mjs` 调用，不能在运行时依赖 `tsc` 或 `ts-node`。
- worker 在隔离 worktree 里运行，worktree 只含已提交文件；构建产物必须在仓库里。

## 决策

- 源码迁到 `src/{cli,lib,hooks,tests}/*.ts`，`tsc -p tsconfig.json` 输出到 `dist/`。
- `dist/` **提交入库**；测试编译为 `dist/tests/*.test.js`，用 `node --test` 运行。
- `bin/hugin-cli.mjs`、`bin/hugin-console.mjs` 保留为薄启动器：设置 `HUGIN_ROOT`、`chdir` 到仓库根，然后 `import dist/...`。
- `.claude/hooks/*.mjs` 保留为薄启动器：设置 `HUGIN_ROOT`，`import dist/hooks/*.js`；**不 chdir**，保留 Claude 传入的真实 cwd，根目录由 `HUGIN_ROOT` 传递。
- 前端单独用 Vite 构建，产物 `web/dist/` 也提交入库。
- `npm run build` = `build-ts` + `build-web`；`npm test` = `build-ts` + `node --test dist/tests/*.test.js`。

根目录解析：TS 侧统一 `ROOT = process.env.HUGIN_ROOT ?? resolve(HERE, '../..')`，这样把 launcher + dist 复制进临时仓库的测试仍能定位根。

## 后果

**收益**

- 状态结构与跨模块接口在编译期检查；`npm run typecheck` 可单独跑。
- hooks 启动零构建依赖；缺 `dist/` 时启动器明确提示 `npm run build`。
- worktree 直接拿到已提交的 `dist/`，行为与主检出一致。
- 测试与源码同语言，共享 fixture 与类型。

**代价**

- `src/` 与 `dist/` 必须同步提交；只改源码不构建会让运行时行为陈旧。`doctor --quick` 会检查 `dist/` 是否存在且可解析。
- 前端 bundle 约 1 MB（antd + React），首次加载比原生页面重；对内网只读看板可接受。
- 构建链多一层：`npm install` 需要 TypeScript、Vite、React 类型包。

## 备选方案

| 方案 | 结论 |
|---|---|
| 继续手写 `.mjs` | 放弃：状态对象跨文件流转，缺类型检查 |
| 运行时用 `tsx` / `ts-node` | 放弃：hooks 每次启动多一层加载，且 worktree 需要额外依赖 |
| 只提交 `src/`，运行时构建 | 放弃：hooks 与 worktree 不能保证先构建 |
| TS + 提交 `dist/` | **采纳** |
