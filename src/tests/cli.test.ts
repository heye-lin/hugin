import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const CLI = path.join(REPO_ROOT, 'bin', 'hugin-cli.mjs');
const DIST = path.join(REPO_ROOT, 'dist');
// Keep git output stable across locales and never prompt for signing keys.
const ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: ENV });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * The CLI resolves its repository root from its own location, so copying the
 * launcher and the build output into a throwaway repository gives each test an
 * isolated root with no side effects.
 */
function makeRepo(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugin-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.copyFileSync(CLI, path.join(root, 'bin', 'hugin-cli.mjs'));
  fs.cpSync(DIST, path.join(root, 'dist'), { recursive: true });

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'hugin@test.local']);
  git(root, ['config', 'user.name', 'Hugin Test']);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);

  const runDir = path.join(root, '.hugin', 'runs', 'r1');
  fs.mkdirSync(path.join(runDir, 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify({ run: 'r1', base: 'HEAD', status: 'active' }),
  );
  return root;
}

function cli(root: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(root, 'bin', 'hugin-cli.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: ENV,
  });
}

function cliWithEnv(
  root: string,
  env: Record<string, string>,
  ...args: string[]
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(root, 'bin', 'hugin-cli.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...ENV, ...env },
  });
}

function worktreePath(root: string, name: string): string {
  return path.join(root, '.claude', 'worktrees', name);
}

function writeHandoff(dir: string, run: string, task: string, handoff: any): string {
  const file = path.join(dir, '.hugin', 'runs', run, 'tasks', task, 'handoff.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(handoff));
  return file;
}

function completeHandoff(run: string, task: string, extra: Record<string, any> = {}): any {
  return {
    run,
    task,
    status: 'complete',
    files_changed: [],
    ac: [{ criterion: 'x', proof: 'y' }],
    ...extra,
  };
}

function readCollected(root: string, run: string, task: string): any {
  return JSON.parse(
    fs.readFileSync(path.join(root, '.hugin', 'runs', run, 'tasks', task, 'collected.json'), 'utf8'),
  );
}

test('work creates a worktree on a new branch and reuses it', (t) => {
  const root = makeRepo(t);
  const first = cli(root, 'work', 'r1', 'T1');
  assert.equal(first.status, 0, first.stderr);

  const dir = worktreePath(root, 'r1-T1');
  assert.ok(fs.existsSync(dir), 'worktree directory exists');
  assert.ok(fs.existsSync(path.join(dir, '.git')), 'worktree has a .git link');
  assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'hugin/T1');
  assert.ok(fs.existsSync(path.join(root, '.hugin', 'runs', 'r1', 'tasks', 'T1', 'worktree.txt')));

  const second = cli(root, 'work', 'r1', 'T1');
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /reused existing worktree/);
});

test('work rejects names that escape .claude/worktrees', (t) => {
  const root = makeRepo(t);
  const result = cli(root, 'work', '../escape', 'T1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid run/);
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'escape-T1')));
});

test('work refuses to delete a plain directory that is not a worktree', (t) => {
  const root = makeRepo(t);
  const stray = worktreePath(root, 'r1-T1');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, 'keep.txt'), 'do not delete');

  const result = cli(root, 'work', 'r1', 'T1');
  assert.notEqual(result.status, 0, 'creating a worktree over a non-empty directory fails');
  assert.ok(fs.existsSync(path.join(stray, 'keep.txt')), 'existing files are preserved');
});

test('work parks an unusable worktree instead of deleting it', (t) => {
  const root = makeRepo(t);
  const stray = worktreePath(root, 'r1-T1');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, '.git'), 'gitdir: /nonexistent/hugin-worktree\n');
  fs.writeFileSync(path.join(stray, 'work.txt'), 'keep me');

  const result = cli(root, 'work', 'r1', 'T1');
  assert.equal(result.status, 0, result.stderr);

  const parent = path.dirname(stray);
  const parked = fs.readdirSync(parent).filter((name) => name.startsWith('r1-T1.stale-'));
  assert.equal(parked.length, 1, 'stale directory is renamed aside');
  assert.ok(fs.existsSync(path.join(parent, parked[0], 'work.txt')), 'old files preserved');
  assert.ok(fs.existsSync(path.join(stray, '.git')), 'a usable worktree now occupies the path');
});

test('collect copies a complete handoff and rejects a blocked one', (t) => {
  const root = makeRepo(t);
  assert.equal(cli(root, 'work', 'r1', 'T1').status, 0);

  const dir = worktreePath(root, 'r1-T1');
  const handoffPath = path.join(dir, '.hugin', 'runs', 'r1', 'tasks', 'T1', 'handoff.json');
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
  fs.writeFileSync(
    handoffPath,
    JSON.stringify({
      run: 'r1',
      task: 'T1',
      status: 'complete',
      files_changed: ['a.py'],
      ac: [{ criterion: 'x', proof: 'y' }],
    }),
  );

  const ok = cli(root, 'collect', 'r1', 'T1');
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(fs.existsSync(path.join(root, '.hugin', 'runs', 'r1', 'tasks', 'T1', 'handoff.json')));

  fs.writeFileSync(handoffPath, JSON.stringify({ run: 'r1', task: 'T1', status: 'blocked' }));
  const blocked = cli(root, 'collect', 'r1', 'T1');
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /status: blocked/);

  fs.writeFileSync(
    handoffPath,
    JSON.stringify({ run: 'r1', task: 'T1', status: 'complete', branch: 'no-such-branch' }),
  );
  const missingBranch = cli(root, 'collect', 'r1', 'T1');
  assert.equal(missingBranch.status, 1);
  assert.match(missingBranch.stderr, /branch does not exist/);
});

test('collect copies referenced logs to the run logs directory, not a nested path', (t) => {
  const root = makeRepo(t);
  assert.equal(cli(root, 'work', 'r1', 'T1').status, 0);

  const dir = worktreePath(root, 'r1-T1');
  const logRef = '.hugin/runs/r1/logs/T1-tests.txt';
  const logPath = path.join(dir, logRef);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '6 tests OK\n');

  const handoffPath = path.join(dir, '.hugin', 'runs', 'r1', 'tasks', 'T1', 'handoff.json');
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
  fs.writeFileSync(
    handoffPath,
    JSON.stringify({
      run: 'r1',
      task: 'T1',
      status: 'complete',
      commands_run: [
        { cmd: 'python -m unittest', exit: 0, log: logRef },
        { cmd: 'node --test', exit: 0, log: '../escape.txt' },
        { cmd: 'noop', exit: 0, log: '' },
      ],
      ac: [{ criterion: 'x', proof: 'y' }],
    }),
  );

  const ok = cli(root, 'collect', 'r1', 'T1');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(
    fs.readFileSync(path.join(root, logRef), 'utf8'),
    '6 tests OK\n',
    'log lands under <root>/.hugin/runs/r1/logs',
  );
  assert.ok(
    !fs.existsSync(path.join(root, '.hugin', 'runs', '.hugin')),
    'no nested .hugin/runs/.hugin path is created',
  );
  assert.ok(!fs.existsSync(path.join(root, '.hugin', 'escape.txt')), 'traversal log ref is ignored');
});

test('collect ignores forged reviews and refuses links', (t) => {
  const root = makeRepo(t);
  assert.equal(cli(root, 'work', 'r1', 'T1').status, 0);

  const dir = worktreePath(root, 'r1-T1');
  const forged = path.join(dir, '.hugin', 'runs', 'r1', 'reviews');
  fs.mkdirSync(forged, { recursive: true });
  fs.writeFileSync(path.join(forged, 'T1-security.json'), JSON.stringify({ findings: [] }));

  assert.equal(cli(root, 'collect', 'r1', 'T1').status, 1, 'missing handoff fails');
  assert.ok(
    !fs.existsSync(path.join(root, '.hugin', 'runs', 'r1', 'reviews', 'T1-security.json')),
    'reviews written inside the worktree are not imported',
  );

  const taskDir = path.join(dir, '.hugin', 'runs', 'r1', 'tasks', 'T1');
  fs.mkdirSync(taskDir, { recursive: true });
  const target = path.join(root, 'secret.txt');
  fs.writeFileSync(target, 'secret');
  try {
    fs.symlinkSync(target, path.join(taskDir, 'handoff.json'));
  } catch {
    t.skip('symlinks need privileges on Windows');
    return;
  }
  const linked = cli(root, 'collect', 'r1', 'T1');
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /regular file/);
});

test('status --json reports counts, queue and workers in a parseable object', (t) => {
  const root = makeRepo(t);
  const runDir = path.join(root, '.hugin', 'runs', 'r1');
  fs.writeFileSync(path.join(root, '.hugin', 'CURRENT_RUN'), 'r1\n');
  fs.writeFileSync(
    path.join(runDir, 'board.json'),
    JSON.stringify({
      run: 'r1',
      tasks: [
        { id: 'T1', title: 'done', owner: 'impl-1', status: 'complete', deps: [] },
        { id: 'T2', title: 'awaiting review', owner: 'impl-2', status: 'review', deps: [] },
        { id: 'T3', title: 'ready', owner: 'impl-3', status: 'pending', deps: ['T1'] },
        { id: 'T4', title: 'blocked dependency', owner: 'impl-4', status: 'pending', deps: ['T2'] },
        { id: 'T5', title: 'waiting on T3', owner: 'impl-5', status: 'pending', deps: ['T3'] },
      ],
    }),
  );

  const agents = [
    { id: 'w1', name: 'hugin-r1-T3-impl', state: 'working', waitingFor: 'tools' },
    { id: 'w2', name: 'hugin-r1-T4-impl', state: 'blocked', waitingFor: 'permission' },
    { id: 'w3', name: 'hugin-other-T1-impl', state: 'working' },
  ];
  const result = cliWithEnv(root, { HUGIN_AGENTS_JSON: JSON.stringify(agents) }, 'status', '--json');
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(path.resolve(payload.repo), path.resolve(root));
  assert.equal(payload.run, 'r1');
  assert.equal(payload.language, 'zh-CN');
  assert.deepEqual(payload.counts, { running: 1, queued: 1, review: 1, blocked: 1, complete: 1 });
  assert.deepEqual(payload.queue, [
    { id: 'T3', title: 'ready', owner: 'impl-3', deps: ['T1'] },
  ]);
  assert.equal(payload.tasks.length, 5);
  assert.deepEqual(payload.workers.map((worker: any) => worker.id), ['w1', 'w2']);
  assert.equal(typeof payload.console.running, 'boolean');
  assert.equal(payload.console.port, 8787);
});

test('status --watch clears the screen and keeps redrawing until interrupted', async (t) => {
  const root = makeRepo(t);
  const child = spawn(
    process.execPath,
    [path.join(root, 'bin', 'hugin-cli.mjs'), 'status', '--watch', '--interval', '0.2'],
    { cwd: root, env: { ...process.env, HUGIN_AGENTS_JSON: '[]' } },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));
  child.kill('SIGTERM');
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  // Windows terminates a process on SIGTERM without running the JS handler, so
  // the exit code is null there; Ctrl-C in a real terminal goes through SIGINT.
  assert.ok(exitCode === 0 || exitCode === null, `unexpected exit code: ${exitCode}`);
  const redraws = (output.match(/counts:/g) ?? []).length;
  assert.ok(redraws >= 2, `expected at least two redraws, got ${redraws}`);
  assert.match(output, /\x1B\[2J/, 'the screen is cleared between redraws');
});

test('console --status reports a stopped console without binding a port', (t) => {
  const root = makeRepo(t);
  const result = cli(root, 'console', '--status', '--json');
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.running, false);
  assert.equal(status.port, 8787);
  assert.equal(status.pid, null);
});

test('collect rejects a handoff for another run or task, and one with no AC', (t) => {
  const root = makeRepo(t);
  assert.equal(cli(root, 'work', 'r1', 'T1').status, 0);
  const dir = worktreePath(root, 'r1-T1');

  writeHandoff(dir, 'r1', 'T1', completeHandoff('r2', 'T1'));
  const wrongRun = cli(root, 'collect', 'r1', 'T1');
  assert.equal(wrongRun.status, 1);
  assert.match(wrongRun.stderr, /handoff\.run/);

  writeHandoff(dir, 'r1', 'T1', completeHandoff('r1', 'T2'));
  const wrongTask = cli(root, 'collect', 'r1', 'T1');
  assert.equal(wrongTask.status, 1);
  assert.match(wrongTask.stderr, /handoff\.task/);

  writeHandoff(dir, 'r1', 'T1', completeHandoff('r1', 'T1', { ac: [] }));
  const noAc = cli(root, 'collect', 'r1', 'T1');
  assert.equal(noAc.status, 1);
  assert.match(noAc.stderr, /ac must be a non-empty array/);

  assert.ok(
    !fs.existsSync(path.join(root, '.hugin', 'runs', 'r1', 'tasks', 'T1', 'handoff.json')),
    'invalid handoffs are not imported',
  );
});

test('collect checks handoff head freshness and records collected.json', (t) => {
  const root = makeRepo(t);
  assert.equal(cli(root, 'work', 'r1', 'T1').status, 0);
  const dir = worktreePath(root, 'r1-T1');
  const head = git(dir, ['rev-parse', 'HEAD']);

  writeHandoff(dir, 'r1', 'T1', completeHandoff('r1', 'T1', { head: '0'.repeat(40) }));
  const stale = cli(root, 'collect', 'r1', 'T1');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /HEAD is/);

  // A short SHA that matches the worktree HEAD is accepted.
  writeHandoff(dir, 'r1', 'T1', completeHandoff('r1', 'T1', { head: head.slice(0, 7) }));
  const ok = cli(root, 'collect', 'r1', 'T1');
  assert.equal(ok.status, 0, ok.stderr);

  const collected = readCollected(root, 'r1', 'T1');
  assert.equal(collected.run, 'r1');
  assert.equal(collected.task, 'T1');
  assert.equal(collected.branch, 'hugin/T1');
  assert.equal(collected.head, head);
  assert.deepEqual(collected.logs, []);
  assert.equal(collected.handoff_created_at, null);
  assert.equal(typeof collected.collected_at, 'string');

  // Without a declared head the handoff is still accepted, with a warning.
  writeHandoff(dir, 'r1', 'T1', completeHandoff('r1', 'T1', { created_at: '2026-01-01T00:00:00Z' }));
  const undeclared = cli(root, 'collect', 'r1', 'T1');
  assert.equal(undeclared.status, 0, undeclared.stderr);
  assert.match(undeclared.stderr, /no head\/commit/);
  assert.equal(readCollected(root, 'r1', 'T1').handoff_created_at, '2026-01-01T00:00:00Z');
});

test('collect imports only this task\'s logs and never overwrites different content', (t) => {
  const root = makeRepo(t);
  assert.equal(cli(root, 'work', 'r1', 'T1').status, 0);
  const dir = worktreePath(root, 'r1-T1');
  const logsDir = path.join(dir, '.hugin', 'runs', 'r1', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'T1-ok.txt'), 'own log\n');
  fs.writeFileSync(path.join(logsDir, 'T2-other.txt'), 'other task\n');
  fs.writeFileSync(path.join(logsDir, '.hidden.txt'), 'hidden\n');
  fs.writeFileSync(path.join(logsDir, '-flag.txt'), 'flag\n');

  const commands = [
    { cmd: 'ok', exit: 0, log: '.hugin/runs/r1/logs/T1-ok.txt' },
    { cmd: 'other task', exit: 0, log: '.hugin/runs/r1/logs/T2-other.txt' },
    { cmd: 'hidden', exit: 0, log: '.hugin/runs/r1/logs/.hidden.txt' },
    { cmd: 'flag', exit: 0, log: '.hugin/runs/r1/logs/-flag.txt' },
  ];
  writeHandoff(dir, 'r1', 'T1', completeHandoff('r1', 'T1', { commands_run: commands }));
  const first = cli(root, 'collect', 'r1', 'T1');
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(readCollected(root, 'r1', 'T1').logs, ['.hugin/runs/r1/logs/T1-ok.txt']);
  assert.match(first.stderr, /another task/);
  assert.match(first.stderr, /must not start with/);
  for (const name of ['T2-other.txt', '.hidden.txt', '-flag.txt']) {
    assert.ok(
      !fs.existsSync(path.join(root, '.hugin', 'runs', 'r1', 'logs', name)),
      `${name} must not be imported`,
    );
  }

  // Re-running collect with changed content leaves the collected log intact.
  fs.writeFileSync(path.join(logsDir, 'T1-ok.txt'), 'new content\n');
  const second = cli(root, 'collect', 'r1', 'T1');
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /different content, not overwriting/);
  assert.equal(
    fs.readFileSync(path.join(root, '.hugin', 'runs', 'r1', 'logs', 'T1-ok.txt'), 'utf8'),
    'own log\n',
  );
});

test('collect skips missing, empty, directory and oversized logs', (t) => {
  const root = makeRepo(t);
  assert.equal(cli(root, 'work', 'r1', 'T1').status, 0);
  const dir = worktreePath(root, 'r1-T1');
  const logsDir = path.join(dir, '.hugin', 'runs', 'r1', 'logs');
  fs.mkdirSync(path.join(logsDir, 'T1-dir'), { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'T1-empty.txt'), '');
  fs.writeFileSync(path.join(logsDir, 'T1-big.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));

  writeHandoff(
    dir,
    'r1',
    'T1',
    completeHandoff('r1', 'T1', {
      commands_run: [
        { cmd: 'missing', exit: 0, log: '.hugin/runs/r1/logs/T1-missing.txt' },
        { cmd: 'empty', exit: 0, log: '.hugin/runs/r1/logs/T1-empty.txt' },
        { cmd: 'directory', exit: 0, log: '.hugin/runs/r1/logs/T1-dir' },
        { cmd: 'oversized', exit: 0, log: '.hugin/runs/r1/logs/T1-big.txt' },
      ],
    }),
  );

  const result = cli(root, 'collect', 'r1', 'T1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /missing/);
  assert.match(result.stderr, /empty/);
  assert.match(result.stderr, /not a regular file/);
  assert.match(result.stderr, /larger than 5 MB/);
  assert.deepEqual(readCollected(root, 'r1', 'T1').logs, []);
  assert.ok(!fs.existsSync(path.join(root, '.hugin', 'runs', 'r1', 'logs', 'T1-empty.txt')));
  assert.ok(!fs.existsSync(path.join(root, '.hugin', 'runs', 'r1', 'logs', 'T1-big.txt')));
});

test('work rejects a --branch that disagrees with the reused worktree, and flags without values', (t) => {
  const root = makeRepo(t);
  assert.equal(cli(root, 'work', 'r1', 'T1').status, 0);

  const mismatch = cli(root, 'work', 'r1', 'T1', '--branch', 'hugin/other');
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /does not match the existing worktree branch/);

  const matching = cli(root, 'work', 'r1', 'T1', '--branch', 'hugin/T1');
  assert.equal(matching.status, 0, matching.stderr);

  const noBranch = cli(root, 'work', 'r1', 'T1', '--branch');
  assert.equal(noBranch.status, 1);
  assert.match(noBranch.stderr, /--branch requires/);

  const noBase = cli(root, 'work', 'r1', 'T1', '--base');
  assert.equal(noBase.status, 1);
  assert.match(noBase.stderr, /--base requires/);
});

test('new-run rejects ids that escape .hugin/runs', (t) => {
  const root = makeRepo(t);

  for (const id of ['../../x', '.hidden', 'a/b']) {
    const result = cli(root, 'new-run', id);
    assert.equal(result.status, 1, `${id} must be rejected`);
    assert.match(result.stderr, /invalid run id/);
  }
  assert.ok(!fs.existsSync(path.join(root, 'x')), 'no directory is created outside the runs tree');
  assert.ok(!fs.existsSync(path.join(root, '.hugin', 'runs', '.hidden')));

  const ok = cli(root, 'new-run', '20261104-ok');
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(fs.existsSync(path.join(root, '.hugin', 'runs', '20261104-ok', 'run.json')));
});

test('a worktree pointer outside .claude/worktrees falls back to the default path', (t) => {
  const root = makeRepo(t);
  assert.equal(cli(root, 'work', 'r1', 'T1').status, 0);
  const pointer = path.join(root, '.hugin', 'runs', 'r1', 'tasks', 'T1', 'worktree.txt');
  fs.writeFileSync(pointer, `${path.join(root, 'outside')}\n`);

  const result = cli(root, 'work', 'r1', 'T1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split(/\r?\n/)[0], worktreePath(root, 'r1-T1'));
});

test('worktree containment honours Windows case-insensitivity', (t) => {
  const root = makeRepo(t);
  assert.equal(cli(root, 'work', 'r1', 'T1').status, 0);
  const real = worktreePath(root, 'r1-T1');
  const pointer = path.join(root, '.hugin', 'runs', 'r1', 'tasks', 'T1', 'worktree.txt');
  const altered =
    process.platform === 'win32' ? real.toUpperCase() : `${real.slice(0, -2)}t1`;
  fs.writeFileSync(pointer, `${altered}\n`);

  const result = cli(root, 'work', 'r1', 'T1');
  assert.equal(result.status, 0, result.stderr);
  const printed = result.stdout.split(/\r?\n/)[0];
  if (process.platform === 'win32') {
    assert.equal(printed, altered, 'a differently-cased pointer is still inside on win32');
  } else {
    assert.equal(printed, real, 'a differently-cased pointer falls back on non-Windows');
  }
});
