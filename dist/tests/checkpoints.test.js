import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as checkpoints from '../lib/checkpoints.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const CLI = path.join(REPO_ROOT, 'bin', 'hugin-cli.mjs');
const DIST = path.join(REPO_ROOT, 'dist');
function git(root, args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
}
/**
 * Every test gets a throwaway repository with its own `.hugin/runs` root, so a
 * checkpoint writes its ledger into the temp tree and never into this repo.
 */
function makeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugin-checkpoints-'));
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.copyFileSync(CLI, path.join(root, 'bin', 'hugin-cli.mjs'));
    fs.cpSync(DIST, path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '.hugin/runs/*\n.hugin/CURRENT_RUN\n.claude/worktrees/\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'hugin@test.local']);
    git(root, ['config', 'user.name', 'Hugin Test']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'init']);
    const runDir = path.join(root, '.hugin', 'runs', 'r1');
    fs.mkdirSync(path.join(runDir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run: 'r1', base: 'HEAD', status: 'active' }));
    return root;
}
function cli(root, ...args) {
    return spawnSync(process.execPath, [path.join(root, 'bin', 'hugin-cli.mjs'), ...args], {
        cwd: root,
        encoding: 'utf8',
    });
}
function makeTask(root, run, task) {
    const created = cli(root, 'work', run, task);
    assert.equal(created.status, 0, created.stderr);
    return path.join(root, '.claude', 'worktrees', `${run}-${task}`);
}
function ledgerOf(root, run) {
    const file = path.join(root, '.hugin', 'runs', run, 'checkpoints.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function defaultBranch(root) {
    return git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
}
function context(root) {
    return {
        root,
        runsDir: path.join(root, '.hugin', 'runs'),
        worktreesDir: path.join(root, '.claude', 'worktrees'),
    };
}
test('checkpoint creates a commit, an annotated tag, and a run ledger', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    const result = cli(root, 'checkpoint', 'r1', 'T1', '--no-push');
    assert.equal(result.status, 0, result.stderr);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(git(dir, ['log', '-1', '--format=%s']), 'hugin(r1/T1): checkpoint');
    assert.equal(git(dir, ['rev-parse', 'refs/tags/hugin/r1/T1^{commit}']), head);
    assert.equal(git(dir, ['cat-file', '-t', 'refs/tags/hugin/r1/T1']), 'tag');
    const ledger = ledgerOf(root, 'r1');
    assert.equal(ledger.run, 'r1');
    assert.equal(ledger.checkpoints.length, 1);
    const entry = ledger.checkpoints[0];
    assert.equal(entry.task, 'T1');
    assert.equal(entry.commit, head);
    assert.equal(entry.tag, 'hugin/r1/T1');
    assert.equal(entry.branch, 'hugin/T1');
    assert.equal(entry.pushed, false);
    assert.ok(entry.created_at, 'created_at is recorded');
});
test('repeated checkpoint on a clean worktree reuses HEAD and does not duplicate the tag', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    assert.equal(cli(root, 'checkpoint', 'r1', 'T1', '--no-push').status, 0);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const second = cli(root, 'checkpoint', 'r1', 'T1', '--no-push');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'clean worktree reuses HEAD');
    assert.equal(git(dir, ['tag', '-l', 'hugin/r1/T1']).split('\n').filter(Boolean).length, 1, 'tag is not duplicated');
    const ledger = ledgerOf(root, 'r1');
    assert.equal(ledger.checkpoints.filter((entry) => entry.task === 'T1').length, 1);
    assert.equal(ledger.checkpoints[0].commit, head);
});
test('checkpoint exits 1 when the tag already points at a different commit', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    assert.equal(cli(root, 'checkpoint', 'r1', 'T1', '--no-push').status, 0);
    fs.appendFileSync(path.join(dir, 'feature.txt'), 'two\n');
    const conflict = cli(root, 'checkpoint', 'r1', 'T1', '--no-push');
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /already points/);
});
test('a failed push is reported, keeps the local checkpoint, and exits 1', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    const result = cli(root, 'checkpoint', 'r1', 'T1');
    assert.equal(result.status, 1, 'no origin remote makes the push fail');
    assert.match(result.stderr, /push/);
    const ledger = ledgerOf(root, 'r1');
    assert.equal(ledger.checkpoints[0].pushed, false);
    assert.equal(git(dir, ['rev-parse', 'refs/tags/hugin/r1/T1^{commit}']), git(dir, ['rev-parse', 'HEAD']), 'local tag and commit survive a failed push');
});
test('rollback --dry-run prints the restore branch without touching the working tree', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    assert.equal(cli(root, 'checkpoint', 'r1', 'T1', '--no-push').status, 0);
    git(root, ['checkout', '-b', 'integration']);
    const branchBefore = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const headBefore = git(root, ['rev-parse', 'HEAD']);
    const result = cli(root, 'rollback', 'r1', 'T1', '--dry-run');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /restore\/r1\/T1-/);
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), branchBefore);
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(git(root, ['branch', '--list', 'restore/*']), '', 'no branch is created');
});
test('rollback --dry-run previews from a dirty tree that a real rollback still refuses', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    assert.equal(cli(root, 'checkpoint', 'r1', 'T1', '--no-push').status, 0);
    const tagCommit = git(dir, ['rev-parse', 'refs/tags/hugin/r1/T1^{commit}']);
    git(root, ['checkout', '-b', 'integration']);
    const branchBefore = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const headBefore = git(root, ['rev-parse', 'HEAD']);
    fs.appendFileSync(path.join(root, 'README.md'), 'dirty\n');
    const preview = checkpoints.rollback(context(root), 'r1', 'T1', { dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.match(preview.branch, /^restore\/r1\/T1-/);
    assert.equal(preview.commit, tagCommit, 'the preview points at the checkpoint tag');
    assert.equal(preview.created, true);
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), branchBefore, 'HEAD branch is unchanged');
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore, 'HEAD commit is unchanged');
    assert.equal(git(root, ['branch', '--list', 'restore/*']), '', 'no branch is created');
    assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /dirty/, 'dirty changes stay');
    assert.throws(() => checkpoints.rollback(context(root), 'r1', 'T1'), /dirty/, 'a real rollback still refuses a dirty tree');
});
test('rollback --dry-run previews from main that a real rollback still refuses', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    assert.equal(cli(root, 'checkpoint', 'r1', 'T1', '--no-push').status, 0);
    const tagCommit = git(dir, ['rev-parse', 'refs/tags/hugin/r1/T1^{commit}']);
    const branchBefore = defaultBranch(root);
    assert.ok(branchBefore === 'main' || branchBefore === 'master', `unexpected default branch ${branchBefore}`);
    const headBefore = git(root, ['rev-parse', 'HEAD']);
    const preview = checkpoints.rollback(context(root), 'r1', 'T1', { dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.match(preview.branch, /^restore\/r1\/T1-/);
    assert.equal(preview.commit, tagCommit, 'the preview points at the checkpoint tag');
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), branchBefore);
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(git(root, ['branch', '--list', 'restore/*']), '', 'no branch is created');
    assert.throws(() => checkpoints.rollback(context(root), 'r1', 'T1'), /refusing to rollback from/, 'a real rollback still refuses to start from main/master');
});
test('rollback creates a restore branch that points at the checkpoint tag', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    assert.equal(cli(root, 'checkpoint', 'r1', 'T1', '--no-push').status, 0);
    const tagCommit = git(dir, ['rev-parse', 'refs/tags/hugin/r1/T1^{commit}']);
    git(root, ['checkout', '-b', 'integration']);
    const result = cli(root, 'rollback', 'r1', 'T1');
    assert.equal(result.status, 0, result.stderr);
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    assert.match(branch, /^restore\/r1\/T1-/);
    assert.equal(git(root, ['rev-parse', 'HEAD']), tagCommit);
    assert.equal(git(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]), tagCommit);
});
test('rollback refuses a dirty working tree', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    assert.equal(cli(root, 'checkpoint', 'r1', 'T1', '--no-push').status, 0);
    git(root, ['checkout', '-b', 'integration']);
    fs.appendFileSync(path.join(root, 'README.md'), 'dirty\n');
    const result = cli(root, 'rollback', 'r1', 'T1');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dirty/);
});
test('rollback refuses to start from main/master', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    assert.equal(cli(root, 'checkpoint', 'r1', 'T1', '--no-push').status, 0);
    const branch = defaultBranch(root);
    assert.ok(branch === 'main' || branch === 'master', `unexpected default branch ${branch}`);
    const result = cli(root, 'rollback', 'r1', 'T1');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to rollback from/);
});
test('rollback and checkpoint reject run/task names that escape the run directory', () => {
    const root = makeRepo();
    const badRun = cli(root, 'checkpoint', '../escape', 'T1', '--no-push');
    assert.equal(badRun.status, 1);
    assert.match(badRun.stderr, /invalid run/);
    const badTask = cli(root, 'rollback', 'r1', '../T1', '--dry-run');
    assert.equal(badTask.status, 1);
    assert.match(badTask.stderr, /invalid task/);
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'escape-T1')));
});
test('checkpoint refuses a task that has no worktree yet', () => {
    const root = makeRepo();
    const result = cli(root, 'checkpoint', 'r1', 'T1', '--no-push');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a git worktree/);
});
test('checkpoints lists the ledger and --json emits it verbatim', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    assert.equal(cli(root, 'checkpoint', 'r1', 'T1', '--no-push').status, 0);
    const listed = cli(root, 'checkpoints', 'r1');
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /T1/);
    assert.match(listed.stdout, /hugin\/r1\/T1/);
    assert.match(listed.stdout, /local/);
    const json = cli(root, 'checkpoints', 'r1', '--json');
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.run, 'r1');
    assert.equal(parsed.checkpoints.length, 1);
    assert.equal(parsed.checkpoints[0].tag, 'hugin/r1/T1');
});
test('rollback rejects a tampered ledger tag before invoking git', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    assert.equal(cli(root, 'checkpoint', 'r1', 'T1', '--no-push').status, 0);
    const file = path.join(root, '.hugin', 'runs', 'r1', 'checkpoints.json');
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    ledger.checkpoints[0].tag = '--git-dir=/tmp/evil';
    fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
    // The context root is not a repository: if git ran, the failure would be
    // about the repository. The tag check must fire first.
    const notRepo = path.join(root, 'not-a-repo');
    fs.mkdirSync(notRepo, { recursive: true });
    assert.throws(() => checkpoints.rollback({
        root: notRepo,
        runsDir: path.join(root, '.hugin', 'runs'),
        worktreesDir: path.join(root, '.claude', 'worktrees'),
    }, 'r1', 'T1'), (error) => error instanceof checkpoints.CheckpointError && /invalid checkpoint tag/.test(error.message));
    assert.equal(git(root, ['branch', '--list', 'restore/*']), '', 'no restore branch is created');
});
test('checkpoint treats a failing git status as an error, not a clean tree', () => {
    const root = makeRepo();
    const dir = makeTask(root, 'r1', 'T1');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'one\n');
    const indexPath = path.resolve(dir, git(dir, ['rev-parse', '--git-path', 'index']));
    fs.writeFileSync(indexPath, 'XXXX this is not a git index');
    assert.throws(() => checkpoints.checkpoint(context(root), 'r1', 'T1', { push: false }), (error) => error instanceof checkpoints.CheckpointError && /git status|index/i.test(error.message), 'a corrupt index must stop the checkpoint');
    // A directory that is not a repository also fails instead of reporting clean.
    const notRepo = path.join(root, 'not-a-repo');
    fs.mkdirSync(path.join(notRepo, 'r1-T1'), { recursive: true });
    assert.throws(() => checkpoints.checkpoint({
        root: notRepo,
        runsDir: path.join(root, '.hugin', 'runs'),
        worktreesDir: notRepo,
    }, 'r1', 'T1', { push: false }), /not a git worktree/);
});
