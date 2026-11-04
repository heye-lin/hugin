import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const DIST_HOOKS = path.join(REPO_ROOT, 'dist', 'hooks');
const ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: ENV });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

/**
 * Hooks are run as separate processes with synthetic stdin, exactly the way
 * Claude invokes them, so this exercises the compiled `dist/hooks` entry points
 * rather than importing their modules.
 */
function makeRepo(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugin-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sub', 'dir'), { recursive: true });
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'hugin@test.local']);
  git(root, ['config', 'user.name', 'Hugin Test']);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);

  const runDir = path.join(root, '.hugin', 'runs', 'r1');
  fs.mkdirSync(path.join(runDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.hugin', 'CURRENT_RUN'), 'r1\n');
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run: 'r1', status: 'active' }));
  return root;
}

function hook(root: string, name: string, input: any): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(DIST_HOOKS, name)], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: ENV,
  });
}

function hookLog(root: string): any[] {
  const file = path.join(root, '.hugin', 'runs', 'r1', 'hooks.log');
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
}

function description(
  evidence = '.hugin/runs/r1/tasks/T1/handoff.json',
  ac = '- x works',
  owner = 'impl-1',
): string {
  return [`Goal: test`, `AC:`, ac, `Files: src/a.ts`, `Evidence: ${evidence}`, `Owner: ${owner}`].join(
    '\n',
  );
}

function writeHandoff(root: string, handoff: any): void {
  const file = path.join(root, '.hugin', 'runs', 'r1', 'tasks', 'T1', 'handoff.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(handoff));
}

test('TaskCreated allows a complete task and logs a repo-relative origin', (t) => {
  const root = makeRepo(t);
  const result = hook(root, 'task-created.js', {
    session_id: 'session-secret',
    cwd: root,
    task_id: 'T1',
    task_subject: 'demo',
    task_description: description(),
  });
  assert.equal(result.status, 0, result.stderr);

  const [entry] = hookLog(root);
  assert.equal(entry.event, 'TaskCreated');
  assert.equal(entry.result, 'allowed');
  assert.equal(entry.task, 'T1');
  assert.equal(entry.cwd, '.');
  assert.ok(!('session_id' in entry), 'session ids are not recorded');
  assert.ok(!JSON.stringify(entry).includes(root), 'the absolute cwd is not recorded');
  assert.ok(!JSON.stringify(entry).includes('session-secret'));
});

test('TaskCreated blocks a task missing AC, Evidence and Owner', (t) => {
  const root = makeRepo(t);
  const result = hook(root, 'task-created.js', {
    cwd: root,
    task_id: 'T2',
    task_subject: 'bad task',
    task_description: 'Goal: no fields',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /缺少必需字段/);

  const [entry] = hookLog(root);
  assert.equal(entry.event, 'TaskCreated');
  assert.equal(entry.result, 'blocked');
  assert.deepEqual(entry.missing, ['AC:', 'Evidence:', 'Owner:']);
  assert.equal(entry.cwd, '.');
});

test('hook logs keep a nested cwd relative to the repository', (t) => {
  const root = makeRepo(t);
  const nested = path.join(root, 'sub', 'dir');
  const result = hook(root, 'task-created.js', {
    cwd: nested,
    task_id: 'T3',
    task_subject: 'nested',
    task_description: description('.hugin/runs/r1/tasks/T3/handoff.json'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(hookLog(root)[0].cwd, path.join('sub', 'dir'));
});

test('TaskCompleted blocks a handoff that is not complete', (t) => {
  const root = makeRepo(t);
  writeHandoff(root, { run: 'r1', task: 'T1', status: 'blocked' });

  const result = hook(root, 'task-completed.js', {
    cwd: root,
    task_id: 'T1',
    task_subject: 'demo',
    task_description: description(),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /status/);

  const [entry] = hookLog(root);
  assert.equal(entry.event, 'TaskCompleted');
  assert.equal(entry.result, 'blocked');
  assert.equal(entry.reason, 'handoff_not_complete');
  assert.equal(entry.cwd, '.');
});

test('TaskCompleted allows a complete handoff and logs it', (t) => {
  const root = makeRepo(t);
  writeHandoff(root, {
    run: 'r1',
    task: 'T1',
    status: 'complete',
    ac: [{ criterion: 'x', proof: 'y' }],
  });

  const result = hook(root, 'task-completed.js', {
    cwd: root,
    task_id: 'T1',
    task_subject: 'demo',
    task_description: description(),
  });
  assert.equal(result.status, 0, result.stderr);

  const [entry] = hookLog(root);
  assert.equal(entry.event, 'TaskCompleted');
  assert.equal(entry.result, 'allowed');
  assert.equal(entry.evidence, '.hugin/runs/r1/tasks/T1/handoff.json');
  assert.equal(entry.cwd, '.');
  assert.ok(!('session_id' in entry));
});

test('TaskCreated logs absolute evidence inside the repo as a relative path', (t) => {
  const root = makeRepo(t);
  // Inside the repository but outside .hugin/runs: blocked, so it is logged.
  const absolute = path.join(root, 'notes', 'handoff.json');
  const result = hook(root, 'task-created.js', {
    cwd: root,
    task_id: 'T1',
    task_subject: 'absolute evidence',
    task_description: description(absolute),
  });
  assert.equal(result.status, 2, 'evidence outside .hugin/runs is still blocked');
  assert.match(result.stderr, /必须位于/);

  const [entry] = hookLog(root);
  assert.equal(entry.result, 'blocked');
  assert.equal(entry.reason, 'evidence_path_outside_runs');
  assert.equal(entry.evidence, 'notes/handoff.json');
  assert.ok(!JSON.stringify(entry).includes(root), 'the log has no absolute path');
});

test('TaskCreated keeps an outside-repo Evidence path out of the log', (t) => {
  const root = makeRepo(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hugin-outside-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const outside = path.join(outsideDir, 'handoff.json');

  const result = hook(root, 'task-created.js', {
    cwd: root,
    task_id: 'T9',
    task_subject: 'outer evidence',
    task_description: description(outside),
  });
  assert.equal(result.status, 2, 'evidence outside .hugin/runs is still blocked');
  assert.match(result.stderr, /必须位于/);

  const [entry] = hookLog(root);
  assert.equal(entry.result, 'blocked');
  assert.equal(entry.reason, 'evidence_path_outside_runs');
  assert.equal(entry.evidence, '<outside-runs>');
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes(outsideDir), 'the outside directory is not logged');
  assert.ok(!serialized.includes(outside), 'the outside absolute path is not logged');
});

test('TaskCompleted logs absolute evidence inside the repo as a relative path', (t) => {
  const root = makeRepo(t);
  writeHandoff(root, { run: 'r1', task: 'T1', status: 'complete', ac: [{ criterion: 'x', proof: 'y' }] });
  const absolute = path.join(root, '.hugin', 'runs', 'r1', 'tasks', 'T1', 'handoff.json');

  const result = hook(root, 'task-completed.js', {
    cwd: root,
    task_id: 'T1',
    task_subject: 'absolute evidence',
    task_description: description(absolute),
  });
  assert.equal(result.status, 0, result.stderr);

  const [entry] = hookLog(root);
  assert.equal(entry.result, 'allowed');
  assert.equal(entry.evidence, '.hugin/runs/r1/tasks/T1/handoff.json');
  assert.ok(!JSON.stringify(entry).includes(root), 'the log has no absolute path');
});

test('TaskCompleted keeps an outside-repo Evidence path out of the log', (t) => {
  const root = makeRepo(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hugin-outside-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const outside = path.join(outsideDir, 'handoff.json');
  fs.writeFileSync(outside, JSON.stringify({ status: 'complete' }));

  const result = hook(root, 'task-completed.js', {
    cwd: root,
    task_id: 'T9',
    task_subject: 'outer evidence',
    task_description: description(outside),
  });
  assert.equal(result.status, 2, 'evidence outside .hugin/runs is still blocked');
  assert.match(result.stderr, /必须位于/);

  const [entry] = hookLog(root);
  assert.equal(entry.result, 'blocked');
  assert.equal(entry.reason, 'evidence_outside_runs');
  assert.equal(entry.evidence, '<outside-runs>');
  assert.ok(!JSON.stringify(entry).includes(outsideDir), 'the outside directory is not logged');
});
