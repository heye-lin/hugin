import fs from 'node:fs';
import path from 'node:path';
import {
  readInput,
  taskDescription,
  field,
  logEvent,
  currentRunId,
  repoRoot,
  fail,
  ok,
  isYes,
} from './lib.mjs';

const input = await readInput();
const cwd = input.cwd || process.cwd();
const origin = { session_id: input.session_id ?? null, cwd };
const subject = input.task_subject ?? input.task?.subject ?? '(untitled)';
const description = taskDescription(input);
const evidence = field(description, 'Evidence');

if (isYes(process.env.HUGIN_SKIP_EVIDENCE)) {
  logEvent(cwd, 'TaskCompleted', {
    ...origin,
    result: 'skipped',
    task: input.task_id,
    subject,
    reason: 'HUGIN_SKIP_EVIDENCE',
  });
  ok();
}

if (!currentRunId(cwd)) {
  // Setup / non-Hugin work should not be blocked before a run exists.
  logEvent(cwd, 'TaskCompleted', {
    ...origin,
    result: 'allowed',
    task: input.task_id,
    subject,
    reason: 'no_current_run',
  });
  ok();
}

if (!evidence) {
  logEvent(cwd, 'TaskCompleted', {
    ...origin,
    result: 'blocked',
    task: input.task_id,
    subject,
    reason: 'missing_evidence_field',
  });
  fail('Hugin: 任务缺少 Evidence: 字段，不能标记完成。请先在任务描述中声明 handoff 路径。');
}

const root = repoRoot(cwd);
const absolute = path.isAbsolute(evidence)
  ? path.resolve(evidence)
  : path.resolve(root, evidence);
const runsRoot = path.resolve(root, '.hugin', 'runs');
if (absolute !== runsRoot && !absolute.startsWith(`${runsRoot}${path.sep}`)) {
  logEvent(cwd, 'TaskCompleted', {
    ...origin,
    result: 'blocked',
    task: input.task_id,
    subject,
    reason: 'evidence_outside_runs',
    evidence,
  });
  fail(`Hugin: Evidence 必须位于 .hugin/runs/ 下，当前解析为：${absolute}`);
}

let handoff;
try {
  handoff = JSON.parse(fs.readFileSync(absolute, 'utf8'));
} catch {
  logEvent(cwd, 'TaskCompleted', {
    ...origin,
    result: 'blocked',
    task: input.task_id,
    subject,
    reason: 'missing_or_invalid_handoff',
    evidence,
  });
  fail([
    `Hugin: 找不到或无法解析证据文件：${evidence}`,
    `期望路径：${absolute}`,
    '请让执行者先写 handoff JSON（见 docs/task-format.md），再标记任务完成。',
  ].join('\n'));
}

if (handoff?.status !== 'complete') {
  logEvent(cwd, 'TaskCompleted', {
    ...origin,
    result: 'blocked',
    task: input.task_id,
    subject,
    reason: 'handoff_not_complete',
    status: handoff?.status ?? '(missing)',
    evidence,
  });
  fail([
    `Hugin: ${evidence} 的 status 是 "${handoff?.status ?? '(missing)'}"，只有 complete 才能完成任务。`,
    '如果工作被阻塞，请保持任务未完成并写明原因。',
  ].join('\n'));
}

logEvent(cwd, 'TaskCompleted', {
  ...origin,
  result: 'allowed',
  task: input.task_id,
  subject,
  evidence,
});
ok();
