import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  buildState,
  listRuns,
  createConsoleServer,
  consolePidPath,
  ensureConsole,
  inspectConsole,
  stopConsole,
} from '../lib/console.js';

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugin-console-'));
  const runDir = path.join(root, '.hugin', 'runs', 'testrun');
  fs.mkdirSync(path.join(runDir, 'tasks', 'T1'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'reviews'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hugin', 'memory'), { recursive: true });

  fs.writeFileSync(path.join(root, '.hugin', 'CURRENT_RUN'), 'testrun\n');
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify({ run: 'testrun', base: 'abc1234', status: 'active' }),
  );
  fs.writeFileSync(
    path.join(runDir, 'board.json'),
    JSON.stringify({
      run: 'testrun',
      tasks: [
        {
          id: 'T1',
          title: 'Fix multiply and add divide',
          owner: 'impl-1',
          status: 'complete',
          files: ['examples/fixture/calc.py'],
          deps: [],
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(runDir, 'brief.md'), 'Fix multiply and implement divide.');
  fs.writeFileSync(
    path.join(runDir, 'tasks', 'T1', 'handoff.json'),
    JSON.stringify({
      status: 'complete',
      branch: 'hugin/T1',
      files_changed: ['examples/fixture/calc.py'],
      commands_run: [{ cmd: 'python3 -m unittest', exit: 0 }],
      ac: [{ criterion: 'multiply(3, 4) == 12', proof: 'ok' }],
      residual_risks: ['none'],
      memory_candidates: [{ text: 'fixture is red by design', why: 'seed' }],
    }),
  );
  fs.writeFileSync(
    path.join(runDir, 'reviews', 'T1-correctness.json'),
    JSON.stringify({
      lens: 'correctness',
      findings: [
        {
          id: 'C1',
          severity: 'high',
          file: 'examples/fixture/calc.py',
          line: 3,
          claim: 'wrong operator',
          evidence: 'test_multiply fails',
          suggestion: 'use *',
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(runDir, 'reviews', 'T1-verdict.json'),
    JSON.stringify({
      verdict: 'BLOCK',
      checks: [{ cmd: 'python3 -m unittest', exit: 0, output: 'OK' }],
      blockers: ['high finding open'],
    }),
  );
  fs.writeFileSync(path.join(root, '.hugin', 'memory', 'INDEX.md'), '# Index\n- one\n');
  fs.writeFileSync(path.join(root, '.hugin', 'memory', 'lessons.md'), '- 2026-11-03: lesson\n');

  return root;
}

test('listRuns reads run metadata', () => {
  const root = makeFixture();
  const runs = listRuns(root);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, 'testrun');
  assert.equal(runs[0].base, 'abc1234');
});

test('buildState hydrates tasks, evidence, reviews, and memory', () => {
  const root = makeFixture();
  const state = buildState({ root });
  assert.equal(state.run.id, 'testrun');
  assert.equal(state.tasks.length, 1);

  const task = state.tasks[0];
  assert.equal(task.id, 'T1');
  assert.equal(task.handoff.status, 'complete');
  assert.equal(task.reviews[0].lens, 'correctness');
  assert.equal(task.openFindings, 1);
  assert.equal(task.verdict.verdict, 'BLOCK');
  assert.equal(task.stage.key, 'review');
  assert.equal(task.stage.action, 'inspect open findings');
  assert.match(state.memory.index, /# Index/);
  assert.match(state.brief, /multiply/);
});

test('buildState marks a blocked worker as attention', () => {
  const root = makeFixture();
  const state = buildState({
    root,
    workers: [
      {
        id: 'w1',
        name: 'hugin-testrun-T1-impl',
        state: 'blocked',
        waitingFor: 'permission to edit',
      },
    ],
  });
  const task = state.tasks[0];
  assert.equal(task.worker.state, 'blocked');
  assert.equal(task.stage.key, 'attention');
  assert.match(task.stage.action, /hugin attach w1/);
  assert.ok(state.attention.some((item) => item.kind === 'attention'));
});

test('buildState surfaces workersError as a system attention item', () => {
  const root = makeFixture();
  const state = buildState({ root, workersError: 'claude not found on PATH' });
  assert.ok(state.attention.some((item) => item.kind === 'system'));
});

test('HTTP API serves state and blocks path traversal', async () => {
  const root = makeFixture();
  const server = createConsoleServer({ root });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = (await fetch(`${base}/healthz`).then((response) => response.json())) as any;
    assert.equal(health.ok, true);

    const runs = (await fetch(`${base}/api/runs`).then((response) => response.json())) as any;
    assert.equal(runs.runs[0].id, 'testrun');

    const stateResponse = await fetch(`${base}/api/state?run=testrun`);
    assert.equal(stateResponse.status, 200);
    const state = (await stateResponse.json()) as any;
    assert.equal(state.run.id, 'testrun');
    assert.equal(state.tasks[0].id, 'T1');
    assert.deepEqual(state.summary, { running: 0, queued: 0, review: 0, blocked: 0, complete: 1 });
    assert.ok(Array.isArray(state.queue), '/api/state exposes the ready queue');
    assert.equal(stateResponse.headers.get('cache-control'), 'no-store');

    const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    assert.ok([403, 404].includes(traversal.status));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('console serves web/dist and allows inline styles for antd', async () => {
  const root = makeFixture();
  const built = path.join(root, 'web', 'dist');
  fs.mkdirSync(path.join(built, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(built, 'index.html'), '<!doctype html><div id="root">built</div>');
  fs.writeFileSync(path.join(built, 'assets', 'app.js'), 'console.log("built");');
  // A stale source index must not win once the build exists.
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html><div id="root">source</div>');

  const server = createConsoleServer({ root });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /built/);
    const csp = index.headers.get('content-security-policy') ?? '';
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);

    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') ?? '', /text\/javascript/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('console falls back to web/ when web/dist is missing', async () => {
  const root = makeFixture();
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html><div id="root">source</div>');

  const server = createConsoleServer({ root });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /source/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeSummaryFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugin-summary-'));
  const runDir = path.join(root, '.hugin', 'runs', 'testrun');
  fs.mkdirSync(path.join(runDir, 'reviews'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hugin', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.hugin', 'CURRENT_RUN'), 'testrun\n');
  writeJson(path.join(runDir, 'run.json'), { run: 'testrun', status: 'active' });
  fs.writeFileSync(path.join(runDir, 'brief.md'), 'summary fixture');
  writeJson(path.join(runDir, 'board.json'), {
    run: 'testrun',
    tasks: [
      { id: 'T1', title: 'done', owner: 'impl-1', status: 'complete', deps: [] },
      { id: 'T2', title: 'verified handoff', owner: 'impl-2', status: 'dispatched', deps: [] },
      { id: 'T3', title: 'awaiting review', owner: 'impl-3', status: 'review', deps: [] },
      { id: 'T4', title: 'unverified handoff', owner: 'impl-4', status: 'dispatched', deps: [] },
      { id: 'T5', title: 'ready', owner: 'impl-5', status: 'pending', deps: ['T1', 'T2'] },
      { id: 'T6', title: 'waiting on review', owner: 'impl-6', status: 'pending', deps: ['T3'] },
      { id: 'T7', title: 'waiting on queue', owner: 'impl-7', status: 'pending', deps: ['T5'] },
    ],
  });
  writeJson(path.join(runDir, 'tasks', 'T2', 'handoff.json'), { status: 'complete' });
  writeJson(path.join(runDir, 'tasks', 'T2', 'verdict.json'), { verdict: 'PASS' });
  writeJson(path.join(runDir, 'tasks', 'T4', 'handoff.json'), { status: 'complete' });
  return root;
}

test('buildState summary counts the run and queues ready work in board order', () => {
  const root = makeSummaryFixture();
  const workers = [
    { id: 'w1', name: 'hugin-testrun-T5-impl', state: 'working' },
    { id: 'w2', name: 'hugin-testrun-T6-impl', state: 'blocked' },
    { id: 'w3', name: 'hugin-other-T1-impl', state: 'working' },
  ];
  const state = buildState({ root, workers });

  assert.deepEqual(state.summary, { running: 1, queued: 1, review: 2, blocked: 1, complete: 2 });
  assert.deepEqual(state.queue, [
    { id: 'T5', title: 'ready', owner: 'impl-5', deps: ['T1', 'T2'] },
  ]);
  assert.equal(state.tasks.find((task) => task.id === 'T4').boardStatus, 'dispatched');
  fs.rmSync(root, { recursive: true, force: true });
});

test('console pidfile prevents duplicate starts and clears a stale pid', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugin-pid-'));
  const pidFile = consolePidPath(root);
  writeJson(pidFile, { pid: 424242, port: 9999, url: 'http://127.0.0.1:9999', startedAt: 'x' });

  const stale = await inspectConsole({ root, deps: { isAlive: () => false } });
  assert.equal(stale.running, false);
  assert.equal(stale.stale, true);
  assert.ok(!fs.existsSync(pidFile), 'a stale pidfile is removed');

  let spawns = 0;
  const deps = {
    isAlive: () => true,
    health: () => true,
    spawn: () => {
      spawns += 1;
      return 1234;
    },
  };
  const first = await ensureConsole({ root, port: 8787, deps });
  assert.equal(first.started, true);
  assert.equal(first.running, true);
  assert.equal(spawns, 1);
  const stored = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(stored.pid, 1234);
  assert.equal(stored.port, 8787);

  const second = await ensureConsole({ root, port: 8787, deps });
  assert.equal(second.started, false);
  assert.equal(second.running, true);
  assert.equal(spawns, 1, 'an alive console is not started twice');

  let terminated = 0;
  const stopped = stopConsole({
    root,
    deps: {
      isAlive: () => true,
      terminate: () => {
        terminated += 1;
      },
    },
  });
  assert.equal(stopped.stopped, true);
  assert.equal(terminated, 1);
  assert.ok(!fs.existsSync(pidFile), 'stop removes the pidfile');
  fs.rmSync(root, { recursive: true, force: true });
});
