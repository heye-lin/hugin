import path from 'node:path';
import {
  readInput,
  taskDescription,
  field,
  logEvent,
  fail,
  ok,
  repoRoot,
} from './lib.js';

const input = await readInput();
const cwd = input.cwd || process.cwd();
const origin = { session_id: input.session_id ?? null, cwd };
const subject = input.task_subject ?? input.task?.subject ?? '(untitled)';
const description = taskDescription(input);

const ac = field(description, 'AC');
const evidence = field(description, 'Evidence');
const owner = field(description, 'Owner');

const missing: string[] = [];
if (!ac || ac.replace(/^-\s*$/gm, '').trim() === '') missing.push('AC:');
if (!evidence) missing.push('Evidence:');
if (!owner) missing.push('Owner:');

if (missing.length > 0) {
  logEvent(cwd, 'TaskCreated', {
    ...origin,
    result: 'blocked',
    task: input.task_id,
    subject,
    missing,
  });
  fail([
    `Hugin: 任务 "${subject}" 缺少必需字段：${missing.join(', ')}`,
    '',
    '请用以下模板重写任务描述：',
    '',
    'Goal: 一句话',
    'AC:',
    '- 可验证的验收标准',
    'Files: 允许修改的文件',
    'Evidence: .hugin/runs/<run>/tasks/<task>/handoff.json',
    'Owner: impl-1 | review-correctness | review-security | review-tests | verify-1',
    'Deps: T0 | none',
    '',
    'AC 与 Evidence 是硬字段，不能为空。',
  ].join('\n'));
}

if (evidence) {
  const runsRoot = path.resolve(repoRoot(cwd), '.hugin', 'runs');
  const absolute = path.isAbsolute(evidence)
    ? path.resolve(evidence)
    : path.resolve(repoRoot(cwd), evidence);
  const inside =
    absolute === runsRoot || absolute.startsWith(`${runsRoot}${path.sep}`);
  if (!inside) {
    logEvent(cwd, 'TaskCreated', {
      ...origin,
      result: 'blocked',
      task: input.task_id,
      subject,
      reason: 'evidence_path_outside_runs',
      evidence,
    });
    fail(
      `Hugin: Evidence 必须位于 .hugin/runs/<run>/ 下，当前为：${evidence}（解析为 ${absolute}）`,
    );
  }
}

logEvent(cwd, 'TaskCreated', {
  ...origin,
  result: 'allowed',
  task: input.task_id,
  subject,
});
ok();
