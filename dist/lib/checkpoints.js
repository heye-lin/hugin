import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
export class CheckpointError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CheckpointError';
    }
}
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// A ledger is hand-editable, and its tag is passed to git as an argument. An
// option-looking or path-bearing tag could be interpreted as a flag or a ref
// outside refs/tags, so only the exact `hugin/<run>/<task>` shape is accepted.
const SAFE_TAG = /^hugin\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
function git(cwd, args) {
    return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}
function ok(result, what) {
    if (result.error)
        throw new CheckpointError(`${what}: ${result.error.message}`);
    if (result.status !== 0) {
        throw new CheckpointError((result.stderr || result.stdout || `${what} exited ${result.status}`).trim());
    }
    return result.stdout.trim();
}
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    }
    catch {
        return null;
    }
}
function safeName(value) {
    return typeof value === 'string' && SAFE_NAME.test(value) && !value.includes('..');
}
function requireRunTask(run, task) {
    for (const [label, value] of [
        ['run', run],
        ['task', task],
    ]) {
        if (!safeName(value)) {
            throw new CheckpointError(`invalid ${label}: ${JSON.stringify(value)} (allowed: letters, digits, dot, underscore, dash)`);
        }
    }
    return { run: run, task: task };
}
function requireRun(run) {
    if (!safeName(run)) {
        throw new CheckpointError(`invalid run: ${JSON.stringify(run)} (allowed: letters, digits, dot, underscore, dash)`);
    }
}
function requireBranch(branch) {
    if (!SAFE_BRANCH.test(branch) || branch.includes('..')) {
        throw new CheckpointError(`invalid branch: ${JSON.stringify(branch)}`);
    }
}
function inside(base, target) {
    const root = path.resolve(base);
    const candidate = path.resolve(target);
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
function samePath(a, b) {
    const left = path.resolve(a);
    const right = path.resolve(b);
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function taskWorktree(ctx, run, task) {
    const fallback = path.join(ctx.worktreesDir, `${run}-${task}`);
    const pointer = path.join(ctx.runsDir, run, 'tasks', task, 'worktree.txt');
    let recorded = '';
    try {
        recorded = fs.readFileSync(pointer, 'utf8').trim();
    }
    catch {
        recorded = '';
    }
    if (!recorded)
        return fallback;
    return inside(ctx.worktreesDir, recorded) ? recorded : fallback;
}
/** A directory is a worktree only when it is the top level of its own checkout. */
function isWorktree(dir) {
    if (!fs.existsSync(dir))
        return false;
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0)
        return false;
    const topLevel = top.stdout.trim();
    return topLevel !== '' && samePath(topLevel, dir);
}
function currentBranch(dir) {
    return ok(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'git branch');
}
function revParseCommit(dir, rev) {
    return ok(git(dir, ['rev-parse', '--verify', `${rev}^{commit}`]), `git rev-parse ${rev}`);
}
function handoffBranch(ctx, run, task) {
    const handoff = readJson(path.join(ctx.runsDir, run, 'tasks', task, 'handoff.json'));
    return typeof handoff?.branch === 'string' ? handoff.branch.trim() : '';
}
function readLedgerFile(file, run) {
    if (!fs.existsSync(file))
        return { run, checkpoints: [] };
    const data = readJson(file);
    if (!data || typeof data !== 'object') {
        throw new CheckpointError(`checkpoint ledger is not valid JSON: ${file}`);
    }
    const checkpoints = Array.isArray(data.checkpoints)
        ? data.checkpoints
            .filter((entry) => entry && typeof entry.task === 'string')
            .map((entry) => {
            if (typeof entry.tag !== 'string' || !SAFE_TAG.test(entry.tag)) {
                throw new CheckpointError(`invalid checkpoint tag in ${file}: ${JSON.stringify(entry.tag)} (expected hugin/<run>/<task>)`);
            }
            return entry;
        })
        : [];
    return { run, checkpoints };
}
function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
/**
 * Commit the task worktree, tag it, and append it to the run ledger.
 *
 * A clean worktree reuses HEAD, and an existing tag that already points at that
 * commit is reused, so running checkpoint twice is idempotent. A tag that points
 * somewhere else is never moved: that would silently rewrite history.
 */
export function checkpoint(ctx, runArg, taskArg, options = {}) {
    const { run, task } = requireRunTask(runArg, taskArg);
    const dir = taskWorktree(ctx, run, task);
    if (!inside(ctx.worktreesDir, dir)) {
        throw new CheckpointError(`refusing worktree path outside .claude/worktrees: ${dir}`);
    }
    if (!isWorktree(dir)) {
        throw new CheckpointError(`not a git worktree: ${dir} (run 'hugin work ${run} ${task}' first)`);
    }
    const branch = currentBranch(dir);
    if (branch === 'main' || branch === 'master') {
        throw new CheckpointError(`refusing to checkpoint on ${branch}`);
    }
    const handedOff = handoffBranch(ctx, run, task);
    const allowed = new Set([`hugin/${task}`, handedOff].filter(Boolean));
    if (!allowed.has(branch)) {
        const expected = handedOff ? `hugin/${task} or ${handedOff}` : `hugin/${task}`;
        throw new CheckpointError(`worktree branch ${branch} is not ${expected}`);
    }
    const note = (options.note ?? '').trim();
    // A failing `git status` is not a clean tree: treating it as clean would tag
    // a commit that misses the worker's changes.
    const dirty = ok(git(dir, ['status', '--porcelain']), 'git status').trim() !== '';
    let commit;
    if (dirty) {
        ok(git(dir, ['add', '-A']), 'git add');
        ok(git(dir, ['commit', '-m', `hugin(${run}/${task}): ${note || 'checkpoint'}`]), 'git commit');
        commit = revParseCommit(dir, 'HEAD');
    }
    else {
        commit = revParseCommit(dir, 'HEAD');
    }
    const createdAt = new Date().toISOString();
    const tag = `hugin/${run}/${task}`;
    const tagRef = `refs/tags/${tag}`;
    const tagExists = git(dir, ['rev-parse', '--verify', '--quiet', tagRef]).status === 0;
    if (tagExists) {
        const tagged = revParseCommit(dir, tagRef);
        if (tagged !== commit) {
            throw new CheckpointError(`tag ${tag} already points at ${tagged.slice(0, 7)}, not ${commit.slice(0, 7)}`);
        }
    }
    else {
        const message = [
            'hugin checkpoint',
            `run: ${run}`,
            `task: ${task}`,
            `commit: ${commit}`,
            `branch: ${branch}`,
            `time: ${createdAt}`,
            `note: ${note || 'checkpoint'}`,
        ].join('\n');
        ok(git(dir, ['tag', '-a', tag, '-m', message, commit]), 'git tag');
    }
    let pushed = false;
    let pushError = '';
    if (options.push !== false) {
        const branchPush = git(dir, ['push', 'origin', branch]);
        if (branchPush.status !== 0) {
            pushError = (branchPush.stderr || branchPush.stdout || 'git push failed').trim();
        }
        else {
            const tagPush = git(dir, ['push', 'origin', `refs/tags/${tag}`]);
            if (tagPush.status !== 0) {
                pushError = (tagPush.stderr || tagPush.stdout || 'git push tag failed').trim();
            }
            else {
                pushed = true;
            }
        }
    }
    const entry = {
        task,
        commit,
        tag,
        branch,
        note,
        created_at: createdAt,
        pushed,
    };
    const ledgerFile = path.join(ctx.runsDir, run, 'checkpoints.json');
    const ledger = readLedgerFile(ledgerFile, run);
    const index = ledger.checkpoints.findIndex((item) => item.task === task);
    if (index === -1)
        ledger.checkpoints.push(entry);
    else
        ledger.checkpoints[index] = entry;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
    return { entry, ledger, ledgerFile, pushError };
}
/** Read the run ledger. A run without any checkpoint has an empty list. */
export function listCheckpoints(ctx, run) {
    requireRun(run);
    return readLedgerFile(path.join(ctx.runsDir, run, 'checkpoints.json'), run);
}
/**
 * Non-destructive restore: create (or reuse) a branch that points at the task's
 * checkpoint tag. Never resets, rebases, or checks anything over an existing
 * checkout, and refuses to start from a dirty tree or from main/master.
 */
export function rollback(ctx, runArg, taskArg, options = {}) {
    const { run, task } = requireRunTask(runArg, taskArg);
    const ledger = readLedgerFile(path.join(ctx.runsDir, run, 'checkpoints.json'), run);
    const entry = [...ledger.checkpoints].reverse().find((item) => item.task === task);
    if (!entry)
        throw new CheckpointError(`no checkpoint recorded for ${run}/${task}`);
    const tagCommit = git(ctx.root, ['rev-parse', '--verify', `${entry.tag}^{commit}`]);
    if (tagCommit.status !== 0) {
        throw new CheckpointError(`checkpoint tag ${entry.tag} does not exist`);
    }
    const commit = tagCommit.stdout.trim();
    const dryRun = options.dryRun === true;
    // A preview must work from any state: the dirty-tree and main/master guards
    // only protect operations that would actually move the checkout.
    if (!dryRun) {
        const status = git(ctx.root, ['status', '--porcelain']);
        if (status.status !== 0) {
            throw new CheckpointError((status.stderr || 'failed to read git status').trim());
        }
        if (status.stdout.trim() !== '') {
            throw new CheckpointError('working tree is dirty; commit or stash changes before rollback');
        }
        const current = currentBranch(ctx.root);
        if (current === 'main' || current === 'master') {
            throw new CheckpointError(`refusing to rollback from ${current}; switch to a working branch first`);
        }
    }
    const branch = (options.branch ?? '').trim() || `restore/${run}/${task}-${stamp()}`;
    requireBranch(branch);
    const exists = git(ctx.root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
    if (exists) {
        const at = revParseCommit(ctx.root, branch);
        if (at !== commit) {
            throw new CheckpointError(`branch ${branch} already exists at ${at.slice(0, 7)}, not ${commit.slice(0, 7)}`);
        }
    }
    if (!dryRun) {
        const checked = git(ctx.root, exists ? ['checkout', branch] : ['checkout', '-b', branch, commit]);
        if (checked.status !== 0) {
            throw new CheckpointError((checked.stderr || checked.stdout || 'git checkout failed').trim());
        }
    }
    return { entry, tag: entry.tag, commit, branch, dryRun, created: !exists };
}
