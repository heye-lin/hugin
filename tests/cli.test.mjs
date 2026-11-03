import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/hugin-cli.mjs', import.meta.url));

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * The CLI resolves its repository root from its own location, so copying it into
 * a throwaway repository gives each test an isolated root with no side effects.
 */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugin-cli-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.copyFileSync(CLI, path.join(root, 'bin', 'hugin-cli.mjs'));

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'hugin@test.local']);
  git(root, ['config', 'user.name', 'Hugin Test']);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'init']);

  const runDir = path.join(root, '.hugin', 'runs', 'r1');
  fs.mkdirSync(path.join(runDir, 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify({ run: 'r1', base: 'HEAD', status: 'active' }),
  );
  return root;
}

function cli(root, ...args) {
  return spawnSync(process.execPath, [path.join(root, 'bin', 'hugin-cli.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function worktreePath(root, name) {
  return path.join(root, '.claude', 'worktrees', name);
}

test('work creates a worktree on a new branch and reuses it', () => {
  const root = makeRepo();
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

test('work rejects names that escape .claude/worktrees', () => {
  const root = makeRepo();
  const result = cli(root, 'work', '../escape', 'T1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid run/);
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'escape-T1')));
});

test('work refuses to delete a plain directory that is not a worktree', () => {
  const root = makeRepo();
  const stray = worktreePath(root, 'r1-T1');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, 'keep.txt'), 'do not delete');

  const result = cli(root, 'work', 'r1', 'T1');
  assert.notEqual(result.status, 0, 'creating a worktree over a non-empty directory fails');
  assert.ok(fs.existsSync(path.join(stray, 'keep.txt')), 'existing files are preserved');
});

test('work parks an unusable worktree instead of deleting it', () => {
  const root = makeRepo();
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

test('collect copies a complete handoff and rejects a blocked one', () => {
  const root = makeRepo();
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

test('collect copies referenced logs to the run logs directory, not a nested path', () => {
  const root = makeRepo();
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

test('collect ignores forged reviews and refuses links', () => {
  const root = makeRepo();
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
    return; // Symlinks need privileges on Windows; skip the link half.
  }
  const linked = cli(root, 'collect', 'r1', 'T1');
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /regular file/);
});
