#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as checkpoints from '../lib/checkpoints.js';
import { buildState, ensureConsole, inspectConsole, stopConsole, DEFAULT_CONSOLE_PORT, } from '../lib/console.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.HUGIN_ROOT
    ? path.resolve(process.env.HUGIN_ROOT)
    : path.resolve(HERE, '../..');
process.chdir(ROOT);
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const rest = argv.slice(1);
const isWin = process.platform === 'win32';
const CLAUDE = process.env.HUGIN_CLAUDE || (isWin ? 'claude.exe' : 'claude');
const HUGIN = path.join(ROOT, '.hugin');
const RUNS = path.join(HUGIN, 'runs');
const CONFIG = path.join(HUGIN, 'config.json');
const CURRENT_RUN = path.join(HUGIN, 'CURRENT_RUN');
const WORKTREES = path.join(ROOT, '.claude', 'worktrees');
function sh(bin, args, opts = {}) {
    return spawnSync(bin, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}
function capture(bin, args, opts = {}) {
    return spawnSync(bin, args, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 15000,
        ...opts,
    });
}
function claude(args, opts = {}) {
    return sh(CLAUDE, args, opts);
}
function claudeCapture(args) {
    return capture(CLAUDE, args);
}
/**
 * Hugin background sessions only. `HUGIN_AGENTS_JSON` injects a canned
 * `claude agents --json` payload so status tests never shell out to claude.
 */
function readClaudeWorkers() {
    let raw;
    const injected = process.env.HUGIN_AGENTS_JSON;
    if (injected !== undefined) {
        raw = injected;
    }
    else {
        const result = claudeCapture(['agents', '--json', '--all']);
        if (result.error)
            return { workers: [], error: result.error.message };
        raw = result.stdout;
    }
    let all;
    try {
        all = JSON.parse(raw);
    }
    catch {
        return { workers: [], error: 'claude agents did not return JSON' };
    }
    const workers = (Array.isArray(all) ? all : [])
        .filter((worker) => typeof worker?.name === 'string' && worker.name.startsWith('hugin-'))
        .map((worker) => ({
        id: String(worker.id ?? ''),
        name: String(worker.name ?? ''),
        state: String(worker.state ?? worker.status ?? 'unknown'),
        waitingFor: worker.waitingFor ?? null,
    }));
    return { workers, error: null };
}
function parsePortArgs(args) {
    const inline = args.find((arg) => arg.startsWith('--port='));
    let raw;
    if (inline) {
        raw = inline.slice('--port='.length);
    }
    else if (args.includes('--port')) {
        raw = args[args.indexOf('--port') + 1];
    }
    if (raw === undefined || raw === '')
        raw = process.env.HUGIN_CONSOLE_PORT;
    if (raw === undefined || raw === '')
        raw = String(DEFAULT_CONSOLE_PORT);
    const port = Number(raw);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : NaN;
}
function read(file, fallback = '') {
    try {
        return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    }
    catch {
        return fallback;
    }
}
function readJson(file) {
    try {
        return JSON.parse(read(file));
    }
    catch {
        return null;
    }
}
function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}
function fail(message) {
    console.error(message);
    process.exit(1);
}
function exitWith(result) {
    if (result.error) {
        console.error(`failed to run: ${result.error.message}`);
        process.exit(1);
    }
    process.exit(result.status ?? 1);
}
function flagValue(args, name) {
    const index = args.indexOf(name);
    return index === -1 ? '' : (args[index + 1] ?? '');
}
/**
 * Read `--name value` or `--name=value`. A flag with no value is reported as
 * given-but-empty so callers can fail instead of silently falling back to a
 * default that hides the user's typo.
 */
function optionValue(args, name) {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline !== undefined)
        return { given: true, value: inline.slice(name.length + 1) };
    const index = args.indexOf(name);
    if (index === -1)
        return { given: false, value: '' };
    const next = args[index + 1];
    return { given: true, value: next && !next.startsWith('--') ? next : '' };
}
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function requireSafeRunTask(run, task) {
    const pairs = [
        ['run', run],
        ['task', task],
    ];
    for (const [label, value] of pairs) {
        if (!SAFE_NAME.test(value ?? '') || (value ?? '').includes('..')) {
            fail(`invalid ${label}: ${JSON.stringify(value)} (allowed: letters, digits, dot, underscore, dash)`);
        }
    }
}
/**
 * Path containment check. Windows paths are case-insensitive, so a recorded
 * path that differs only in case still points inside the directory; on other
 * platforms the same difference is a different path.
 */
function inside(base, target) {
    const root = path.resolve(base);
    const candidate = path.resolve(target);
    if (isWin) {
        const lowerRoot = root.toLowerCase();
        const lowerCandidate = candidate.toLowerCase();
        return lowerCandidate === lowerRoot || lowerCandidate.startsWith(`${lowerRoot}${path.sep}`);
    }
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
function samePath(a, b) {
    const left = path.resolve(a);
    const right = path.resolve(b);
    return isWin ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function taskWorktree(run, task) {
    const fallback = path.join(WORKTREES, `${run}-${task}`);
    const recorded = read(path.join(RUNS, run, 'tasks', task, 'worktree.txt')).trim();
    if (!recorded)
        return fallback;
    return inside(WORKTREES, recorded) ? recorded : fallback;
}
/**
 * A directory counts as a worktree only when it is the top level of its own
 * checkout. Plain subdirectories of the repo also make `rev-parse --git-dir`
 * succeed, so that command alone would treat any directory as a worktree.
 */
function isWorktree(dir) {
    if (!fs.existsSync(dir))
        return false;
    const top = capture('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    if (top.status !== 0)
        return false;
    const topLevel = top.stdout.trim();
    return topLevel !== '' && samePath(topLevel, dir);
}
/**
 * Park worktrees whose checkout is unusable from this platform. A worktree
 * created under WSL records an absolute `/mnt/...` gitdir that Windows git
 * cannot resolve, which makes `git worktree list` report it as prunable.
 *
 * The directory is never deleted: on another platform it may hold the only copy
 * of uncommitted work. It is renamed aside, and only when git itself reports
 * that the directory is not a repository.
 */
function pruneStaleWorktree(dir) {
    if (!fs.existsSync(dir) || isWorktree(dir))
        return false;
    const probe = capture('git', ['-C', dir, 'rev-parse', '--git-dir']);
    const reason = `${probe.stderr ?? ''}${probe.stdout ?? ''}`;
    if (!/not a git repository|cannot change to|no such file or directory/i.test(reason)) {
        console.error(`left worktree in place (unexpected git error): ${reason.trim()}`);
        return false;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const parked = `${dir}.stale-${stamp}`;
    fs.renameSync(dir, parked);
    // `git worktree prune` is global: it drops the admin entry of every worktree
    // whose directory is gone, including registrations that another platform can
    // still use. Ask git for the candidates first and prune only when this
    // checkout (or the parked copy) is among them; otherwise the entry belongs to
    // a worktree that is merely unreachable from here and must be left alone.
    const dryRun = capture('git', ['worktree', 'prune', '--dry-run', '--verbose']);
    const candidates = `${dryRun.stdout ?? ''}${dryRun.stderr ?? ''}`;
    const haystack = isWin ? candidates.toLowerCase() : candidates;
    // Dry-run names candidates by their admin id (usually the worktree directory
    // basename), so match the basename as a whole token: `r1-T1` must not match
    // the different worktree `r1-T10`.
    const basename = isWin ? path.basename(dir).toLowerCase() : path.basename(dir);
    const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const idPattern = new RegExp(`(^|[\\s/\\\\])${escaped}(?=[:\\s]|$)`);
    const touchesThisCheckout = [dir, parked].some((target) => haystack.includes(isWin ? target.toLowerCase() : target)) ||
        idPattern.test(haystack);
    if (touchesThisCheckout) {
        capture('git', ['worktree', 'prune']);
    }
    else {
        console.error('kept the git worktree registry: this checkout is not a prune candidate');
    }
    console.error(`moved unusable worktree aside: ${parked}`);
    console.error('  inspect it before deleting; its .git link points at another platform');
    return true;
}
function work(run, task, args) {
    if (!run || !task)
        fail('usage: hugin work <run> <task> [--base <sha>] [--branch <name>]');
    requireSafeRunTask(run, task);
    const meta = readJson(path.join(RUNS, run, 'run.json'));
    const baseOption = optionValue(args, '--base');
    const branchOption = optionValue(args, '--branch');
    if (baseOption.given && !baseOption.value) {
        fail('hugin work: --base requires a commit');
    }
    if (branchOption.given && !branchOption.value) {
        fail('hugin work: --branch requires a branch name');
    }
    const base = baseOption.value || meta?.base || 'HEAD';
    const branch = branchOption.value || `hugin/${task}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) {
        fail(`invalid branch: ${JSON.stringify(branch)}`);
    }
    const dir = taskWorktree(run, task);
    if (!inside(WORKTREES, dir))
        fail(`refusing worktree path outside .claude/worktrees: ${dir}`);
    const pointer = path.join(RUNS, run, 'tasks', task, 'worktree.txt');
    if (pruneStaleWorktree(dir)) {
        console.error(`pruned stale worktree: ${dir}`);
    }
    if (isWorktree(dir)) {
        const currentBranch = requireOk(capture('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']), 'git branch').trim();
        // Reusing a worktree is fine, but silently ignoring an explicit --branch
        // would let a caller believe it was placed on the branch it asked for.
        if (branchOption.given && currentBranch !== branchOption.value) {
            fail(`--branch ${branchOption.value} does not match the existing worktree branch ${currentBranch} (${dir})`);
        }
        write(pointer, `${dir}\n`);
        console.log(dir);
        console.log(`branch: ${currentBranch}`);
        const current = requireOk(capture('git', ['-C', dir, 'rev-parse', 'HEAD']), 'git head').trim();
        console.log(`head:   ${current.slice(0, 7)}`);
        console.log('(reused existing worktree)');
        if (baseOption.given) {
            const wanted = capture('git', ['rev-parse', '--verify', `${baseOption.value}^{commit}`]);
            if (wanted.status === 0 && wanted.stdout.trim() !== current) {
                console.error(`warning: existing worktree is at ${current.slice(0, 7)}, not --base ${baseOption.value}`);
            }
        }
        return;
    }
    const rev = capture('git', ['rev-parse', '--verify', `${base}^{commit}`]);
    if (rev.status !== 0)
        fail(`unknown base commit: ${base}`);
    const sha = rev.stdout.trim();
    const branchExists = capture('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
    const addArgs = branchExists
        ? ['worktree', 'add', dir, branch]
        : ['worktree', 'add', '-b', branch, dir, sha];
    const added = capture('git', addArgs);
    if (added.status !== 0) {
        fail((added.stderr || added.stdout || 'git worktree add failed').trim());
    }
    write(pointer, `${dir}\n`);
    console.log(dir);
    console.log(`branch: ${branch}${branchExists ? ' (existing)' : ''}`);
    const headSha = requireOk(capture('git', ['-C', dir, 'rev-parse', 'HEAD']), 'git head').trim();
    console.log(`head:   ${headSha.slice(0, 7)}`);
    if (branchExists && headSha !== sha) {
        console.error(`warning: branch ${branch} is at ${headSha.slice(0, 7)}, not the requested base ${base} (${sha.slice(0, 7)})`);
    }
}
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/**
 * Copy the worker's handoff out of its worktree. Reviews and verdicts are NOT
 * collected: the implementer can write inside its worktree, so importing them
 * would let it forge reviewer/verifier evidence. The Master stages those from
 * the reviewer's own final message instead.
 */
function collect(run, task) {
    if (!run || !task)
        fail('usage: hugin collect <run> <task>');
    requireSafeRunTask(run, task);
    const worktree = taskWorktree(run, task);
    if (!inside(WORKTREES, worktree)) {
        fail(`refusing to read evidence outside .claude/worktrees: ${worktree}`);
    }
    const relative = path.join('tasks', task, 'handoff.json');
    const from = path.join(worktree, '.hugin', 'runs', run, relative);
    const to = path.join(RUNS, run, relative);
    let stat;
    try {
        stat = fs.lstatSync(from);
    }
    catch {
        fail(`worktree evidence not found: ${from}\nRun 'hugin work ${run} ${task}' first, and make sure the worker wrote its handoff inside the worktree.`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        fail(`handoff must be a regular file, not a link or directory: ${from}`);
    }
    const text = read(from);
    let handoff;
    try {
        handoff = JSON.parse(text);
    }
    catch {
        fail(`handoff is not valid JSON: ${from}`);
    }
    const headProbe = capture('git', ['-C', worktree, 'rev-parse', 'HEAD']);
    if (headProbe.status !== 0) {
        fail(`could not read the worktree HEAD: ${(headProbe.stderr || headProbe.stdout || '').trim()}`);
    }
    const head = headProbe.stdout.trim();
    const branchProbe = capture('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = typeof handoff.branch === 'string' ? handoff.branch.trim() : '';
    if (branch) {
        const exists = capture('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
        if (!exists)
            fail(`handoff.branch does not exist: ${branch}`);
    }
    const declared = typeof handoff.worktree === 'string' ? handoff.worktree.trim() : '';
    if (declared && !samePath(declared, worktree)) {
        console.error(`warning: handoff.worktree (${declared}) differs from the worktree on disk (${worktree})`);
    }
    const complete = handoff.status === 'complete';
    if (complete) {
        // A handoff is evidence for one task in one run; a mismatch means the
        // worker wrote (or copied) the wrong file and must not pass silently.
        if (handoff.run !== run) {
            fail(`handoff.run is ${JSON.stringify(handoff.run)}, expected ${JSON.stringify(run)}: ${from}`);
        }
        if (handoff.task !== task) {
            fail(`handoff.task is ${JSON.stringify(handoff.task)}, expected ${JSON.stringify(task)}: ${from}`);
        }
        if (!Array.isArray(handoff.ac) || handoff.ac.length === 0) {
            fail(`handoff.ac must be a non-empty array of acceptance criteria: ${from}`);
        }
        const declaredHead = [handoff.head, handoff.commit]
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .find((value) => value !== '');
        if (declaredHead) {
            const expected = declaredHead.toLowerCase();
            const actual = head.toLowerCase();
            const matches = actual === expected || (expected.length >= 7 && actual.startsWith(expected));
            if (!matches) {
                fail(`handoff declares ${declaredHead}, but the worktree HEAD is ${head}. Run 'hugin checkpoint' first or refresh the handoff.`);
            }
        }
        else {
            console.error('warning: handoff declares no head/commit; freshness cannot be checked');
        }
    }
    write(to, text);
    console.log(`collected 1 file into .hugin/runs/${run}:`);
    console.log(`  ${relative}`);
    const logs = [];
    const logsPrefix = `.hugin/runs/${run}/logs/`;
    const runsReal = fs.realpathSync(RUNS);
    const worktreeReal = fs.realpathSync(worktree);
    for (const entry of Array.isArray(handoff.commands_run) ? handoff.commands_run : []) {
        const ref = typeof entry?.log === 'string' ? entry.log.trim().replace(/\\/g, '/') : '';
        if (!ref || !ref.startsWith(logsPrefix))
            continue;
        const name = ref.slice(logsPrefix.length);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
            console.error(`warning: log name must not start with '-' or '.' and cannot contain directories: ${ref}`);
            continue;
        }
        // Logs are per task; importing another task's log would mix evidence.
        if (!name.startsWith(`${task}-`)) {
            console.error(`warning: log belongs to another task, not imported: ${ref}`);
            continue;
        }
        const logFrom = path.join(worktree, ref);
        const logTo = path.join(ROOT, ref);
        if (!inside(RUNS, logTo)) {
            console.error(`warning: referenced log is outside .hugin/runs: ${ref}`);
            continue;
        }
        let logStat;
        try {
            logStat = fs.lstatSync(logFrom);
        }
        catch {
            console.error(`warning: referenced log is missing in the worktree: ${ref}`);
            continue;
        }
        if (logStat.isSymbolicLink() || !logStat.isFile()) {
            console.error(`warning: referenced log is not a regular file: ${ref}`);
            continue;
        }
        if (logStat.size === 0) {
            console.error(`warning: referenced log is empty: ${ref}`);
            continue;
        }
        if (logStat.size > MAX_LOG_BYTES) {
            console.error(`warning: referenced log is larger than 5 MB: ${ref}`);
            continue;
        }
        const fromReal = fs.realpathSync(logFrom);
        if (!inside(worktreeReal, fromReal)) {
            console.error(`warning: referenced log escapes the worktree: ${ref}`);
            continue;
        }
        const targetDir = path.dirname(logTo);
        fs.mkdirSync(targetDir, { recursive: true });
        if (!inside(runsReal, fs.realpathSync(targetDir))) {
            console.error(`warning: log target escapes .hugin/runs: ${ref}`);
            continue;
        }
        if (fs.existsSync(logTo)) {
            if (!fs.readFileSync(logTo).equals(fs.readFileSync(logFrom))) {
                console.error(`warning: log already exists with different content, not overwriting: ${ref}`);
                continue;
            }
        }
        write(logTo, fs.readFileSync(logFrom, 'utf8'));
        logs.push(ref);
    }
    for (const ref of logs)
        console.log(`  ${ref}`);
    if (!complete) {
        console.error(`handoff status: ${handoff.status ?? '(missing)'} — TaskCompleted will block.`);
        process.exit(1);
    }
    const collected = {
        run,
        task,
        branch: branchProbe.status === 0 ? branchProbe.stdout.trim() : branch,
        head,
        handoff_created_at: typeof handoff.created_at === 'string' ? handoff.created_at : null,
        collected_at: new Date().toISOString(),
        logs,
    };
    write(path.join(RUNS, run, 'tasks', task, 'collected.json'), `${JSON.stringify(collected, null, 2)}\n`);
    const criteria = Array.isArray(handoff.ac) ? handoff.ac.length : 0;
    const changed = Array.isArray(handoff.files_changed) ? handoff.files_changed.length : 0;
    console.log(`handoff: status=complete ac=${criteria} files_changed=${changed}`);
}
function checkpointContext() {
    return { root: ROOT, runsDir: RUNS, worktreesDir: WORKTREES };
}
function checkpoint(run, task, args) {
    const noPush = args.includes('--no-push');
    try {
        const result = checkpoints.checkpoint(checkpointContext(), run, task, {
            note: flagValue(args, '--note'),
            push: !noPush,
        });
        const { entry } = result;
        console.log(`checkpoint ${entry.task} @ ${entry.commit.slice(0, 7)}`);
        console.log(`  branch: ${entry.branch}`);
        console.log(`  tag:    ${entry.tag}`);
        console.log(`  ledger: ${path.relative(ROOT, result.ledgerFile)}`);
        if (noPush) {
            console.log('  push:   skipped (--no-push)');
        }
        else if (result.pushError) {
            console.error(`  push:   failed — ${result.pushError}`);
        }
        else {
            console.log(`  push:   origin ${entry.branch} + ${entry.tag}`);
        }
        if (result.pushError)
            process.exit(1);
    }
    catch (error) {
        fail(error.message);
    }
}
function listCheckpoints(run, args) {
    if (!run)
        fail('usage: hugin checkpoints <run> [--json]');
    try {
        const ledger = checkpoints.listCheckpoints(checkpointContext(), run);
        if (args.includes('--json')) {
            console.log(JSON.stringify(ledger, null, 2));
            return;
        }
        if (ledger.checkpoints.length === 0) {
            console.log(`checkpoints: none for ${run}`);
            return;
        }
        console.log(`checkpoints: ${ledger.run} (${ledger.checkpoints.length})`);
        for (const entry of ledger.checkpoints) {
            const pushed = entry.pushed ? 'pushed' : 'local';
            console.log(`  ${entry.task.padEnd(12)} ${entry.commit.slice(0, 7)}  ${entry.tag.padEnd(28)} ${entry.created_at}  ${pushed}`);
        }
    }
    catch (error) {
        fail(error.message);
    }
}
function rollback(run, task, args) {
    try {
        const result = checkpoints.rollback(checkpointContext(), run, task, {
            branch: flagValue(args, '--branch'),
            dryRun: args.includes('--dry-run'),
        });
        if (result.dryRun) {
            console.log(`rollback ${result.entry.task}: dry run`);
            console.log(`  tag:    ${result.tag} -> ${result.commit.slice(0, 7)}`);
            console.log(`  branch: ${result.branch}${result.created ? ' (would create)' : ' (exists)'}`);
            console.log('  no branch was created and the working tree was not touched');
            return;
        }
        console.log(`rollback ${result.entry.task}: ${result.tag} -> ${result.commit.slice(0, 7)}`);
        console.log(`  switched to branch: ${result.branch}`);
    }
    catch (error) {
        fail(error.message);
    }
}
function usage() {
    console.log(`Hugin

Usage:
  hugin start [--no-console] [--port N]
                              Start the master Claude session (starts the web console too)
  hugin dashboard             Open the background-agent dashboard (claude agents)
  hugin console [--port N]    Serve the read-only web console on 127.0.0.1
  hugin console --status|--stop
                              Show or stop the background web console
  hugin ps [--all]            Print background sessions as JSON
  hugin attach <id|name>      Attach this terminal to a background session
  hugin logs <id|name>        Print recent output of a background session
  hugin stop <id|name>        Stop a background session
  hugin new-run [run-id]      Create .hugin/runs/<run-id> and set CURRENT_RUN
  hugin work <run> <task>     Create or reuse the task's isolated worktree
  hugin collect <run> <task>  Copy the task handoff and its referenced logs out of the worktree
  hugin checkpoint <run> <task> [--note <text>] [--no-push]
                              Commit and tag the task worktree, record the run ledger
  hugin checkpoints <run> [--json]
                              List the run's recorded checkpoints
  hugin rollback <run> <task> [--branch <name>] [--dry-run]
                              Create a restore branch at the task's checkpoint
  hugin memory                Show the project memory index and recent lessons
  hugin remember <text>       Append a dated lesson to .hugin/memory/lessons.md
  hugin recall <query>        Search .hugin/memory and run evidence
  hugin status [--all] [--json] [--watch [--interval N]]
                              Show current run, counts, queue and background sessions
  hugin lang [zh|en|<code>]   Show or set the run language (default zh-CN)
  hugin doctor [--quick]      Check the environment (no mutating actions)
  hugin help                  Show this help`);
}
function currentLanguage() {
    const config = readJson(CONFIG);
    return typeof config?.language === 'string' && config.language.trim()
        ? config.language.trim()
        : 'zh-CN';
}
function setLanguage(code) {
    const config = readJson(CONFIG) || {};
    config.language = code;
    write(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
}
function lang(value) {
    if (!value) {
        console.log(currentLanguage());
        return;
    }
    const key = String(value).toLowerCase();
    let code;
    if (['zh', 'zh-cn', 'cn', 'chinese', '中文'].includes(key)) {
        code = 'zh-CN';
    }
    else if (['en', 'en-us', 'english', '英文', '英语'].includes(key)) {
        code = 'en-US';
    }
    else if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) {
        code = value;
    }
    else {
        fail('usage: hugin lang [zh|en|<bcp47-code>]');
    }
    setLanguage(code);
    console.log(`language: ${code}`);
}
function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function newRun(id) {
    const run = id || stamp();
    // The id becomes a directory name under .hugin/runs; reject anything that can
    // escape it instead of silently creating a run elsewhere.
    if (!SAFE_NAME.test(run) || run.includes('..')) {
        fail(`invalid run id: ${JSON.stringify(run)} (allowed: letters, digits, dot, underscore, dash; no '..')`);
    }
    const dir = path.join(RUNS, run);
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    if (fs.existsSync(path.join(dir, 'run.json'))) {
        write(CURRENT_RUN, `${run}\n`);
        console.error(`run already exists: ${run} (reused)`);
        console.log(run);
        return;
    }
    const baseResult = capture('git', ['rev-parse', '--short', 'HEAD']);
    const base = baseResult.status === 0 ? baseResult.stdout.trim() : 'none';
    write(path.join(dir, 'run.json'), `${JSON.stringify({ run, base, created_at: new Date().toISOString(), status: 'active' }, null, 2)}\n`);
    write(CURRENT_RUN, `${run}\n`);
    console.log(run);
}
function renderStatus(showAll) {
    const run = read(CURRENT_RUN).trim();
    const { workers, error } = readClaudeWorkers();
    const state = buildState({
        root: ROOT,
        runId: run || undefined,
        workers,
        workersError: error,
    });
    const activeRun = state.run?.id ?? (run || '');
    console.log(`repo: ${ROOT}`);
    if (!isWin) {
        const win = capture('wslpath', ['-w', ROOT]);
        if (win.status === 0 && win.stdout.trim())
            console.log(`win:  ${win.stdout.trim()}`);
    }
    console.log(`run:  ${activeRun || '<none>'}`);
    console.log(`lang: ${currentLanguage()}`);
    if (state.run) {
        console.log(`      ${state.run.status ?? 'unknown'}  base=${state.run.base ?? '-'}  created=${state.run.createdAt ?? '-'}`);
    }
    if (state.tasks.length > 0) {
        const byStatus = {};
        for (const task of state.tasks) {
            const status = String(task.boardStatus || task.status || 'unknown');
            byStatus[status] = (byStatus[status] ?? 0) + 1;
        }
        const summary = Object.entries(byStatus)
            .map(([status, count]) => `${status}=${count}`)
            .join(', ');
        console.log(`tasks: ${state.tasks.length} total — ${summary}`);
    }
    const counts = state.summary;
    console.log(`counts: running=${counts.running} queued=${counts.queued} review=${counts.review} blocked=${counts.blocked} complete=${counts.complete}`);
    for (const item of state.queue) {
        console.log(`queued: ${item.id} ${item.title} (${item.owner})`);
    }
    console.log();
    console.log(`background sessions (${showAll ? 'all' : 'active'}):`);
    if (error) {
        console.log(`  (${error})`);
        return;
    }
    const visible = workers.filter((worker) => showAll || String(worker.state ?? '') !== 'stopped');
    if (visible.length === 0) {
        console.log('  (none)');
        const hidden = workers.length - visible.length;
        if (!showAll && hidden > 0) {
            console.log(`  ${hidden} stopped session(s) hidden — use 'ng status --all'`);
        }
        return;
    }
    for (const worker of visible) {
        const id = String(worker.id || '-').padEnd(12);
        const stateLabel = String(worker.state || '-').padEnd(9);
        const name = String(worker.name || '-').padEnd(34);
        console.log(`  ${id} ${stateLabel} ${name} ${worker.waitingFor ?? '-'}`);
    }
}
async function statusJson(args) {
    const run = read(CURRENT_RUN).trim();
    const { workers, error } = readClaudeWorkers();
    const state = buildState({
        root: ROOT,
        runId: run || undefined,
        workers,
        workersError: error,
    });
    const activeRun = state.run?.id ?? null;
    const prefix = activeRun ? `hugin-${activeRun}-` : 'hugin-';
    const scoped = workers.filter((worker) => String(worker.name).startsWith(prefix));
    const port = parsePortArgs(args);
    const consoleStatus = await inspectConsole({
        root: ROOT,
        port: Number.isInteger(port) ? port : DEFAULT_CONSOLE_PORT,
    });
    const payload = {
        repo: ROOT,
        run: activeRun,
        language: currentLanguage(),
        counts: state.summary,
        queue: state.queue,
        tasks: state.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            owner: task.owner,
            status: task.status,
            boardStatus: task.boardStatus,
            stage: task.stage,
            deps: task.deps,
            worker: task.worker,
        })),
        workers: scoped,
        console: {
            running: consoleStatus.running,
            pid: consoleStatus.pid,
            port: consoleStatus.port,
            url: consoleStatus.url,
        },
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
async function statusWatch(showAll, intervalSeconds) {
    const interval = Math.max(0.1, intervalSeconds) * 1000;
    const render = () => {
        process.stdout.write('\x1B[2J\x1B[H');
        renderStatus(showAll);
    };
    render();
    const timer = setInterval(render, interval);
    const stop = () => {
        clearInterval(timer);
        process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await new Promise(() => {
        // Keep the process alive until a signal stops the watcher.
    });
}
function parseStartArgs(args) {
    const consoleArgs = [];
    const claudeArgs = [];
    let noConsole = false;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--no-console') {
            noConsole = true;
            continue;
        }
        if (arg === '--port') {
            consoleArgs.push(arg, args[i + 1] ?? '');
            i += 1;
            continue;
        }
        if (arg.startsWith('--port=')) {
            consoleArgs.push(arg);
            continue;
        }
        claudeArgs.push(arg);
    }
    return { noConsole, consoleArgs, claudeArgs };
}
async function start(args) {
    const parsed = parseStartArgs(args);
    if (!parsed.noConsole) {
        const port = parsePortArgs(parsed.consoleArgs);
        if (!Number.isInteger(port)) {
            fail('usage: hugin start [--no-console] [--port <1-65535>]');
        }
        try {
            const result = await ensureConsole({ root: ROOT, port });
            if (result.started) {
                console.log(`console: started ${result.url} (pid ${result.pid})`);
            }
            else if (result.running) {
                console.log(`console: already running ${result.url} (pid ${result.pid})`);
            }
            else {
                console.error(`console: not started — ${result.error ?? 'unknown error'}`);
            }
            console.log(`  log: ${path.relative(ROOT, path.join(HUGIN, 'logs', 'console.log'))}`);
        }
        catch (error) {
            console.error(`console: ${error.message}`);
        }
    }
    exitWith(claude(parsed.claudeArgs));
}
async function consoleStatusCommand(args) {
    const port = parsePortArgs(args);
    const status = await inspectConsole({
        root: ROOT,
        port: Number.isInteger(port) ? port : DEFAULT_CONSOLE_PORT,
    });
    if (args.includes('--json')) {
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return;
    }
    if (status.running) {
        console.log(`console: running  pid=${status.pid}  ${status.url}`);
    }
    else if (status.stale) {
        console.log('console: stopped (removed stale pidfile)');
    }
    else if (status.pid) {
        console.log(`console: not responding  pid=${status.pid}  ${status.url}`);
    }
    else {
        console.log(`console: stopped  ${status.url}`);
    }
}
function consoleStopCommand() {
    const result = stopConsole({ root: ROOT });
    console.log(result.stopped ? `console: stopped  pid=${result.pid}` : 'console: not running');
}
function memory() {
    console.log('== .hugin/memory/INDEX.md ==');
    const index = read(path.join(HUGIN, 'memory', 'INDEX.md'));
    console.log(index || '(missing)');
    console.log();
    console.log('== recent lessons ==');
    const lessons = read(path.join(HUGIN, 'memory', 'lessons.md'))
        .split(/\r?\n/)
        .filter((line) => line.startsWith('- '))
        .slice(-20);
    console.log(lessons.join('\n') || '(none)');
}
function remember(text) {
    if (!text)
        fail('usage: hugin remember <text>');
    const file = path.join(HUGIN, 'memory', 'lessons.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `- ${new Date().toISOString().slice(0, 10)}: ${text}\n`);
    console.log(`remembered: ${text}`);
    console.log('file: .hugin/memory/lessons.md');
}
function walk(dir, out = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules')
            continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, out);
        }
        else if (/\.(md|json)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}
function recall(query) {
    if (!query)
        fail('usage: hugin recall <query>');
    const needle = query.toLowerCase();
    const roots = [path.join(HUGIN, 'memory'), RUNS];
    let printed = 0;
    for (const file of roots.flatMap((root) => walk(root))) {
        const lines = read(file).split(/\r?\n/);
        for (let i = 0; i < lines.length && printed < 40; i += 1) {
            if (lines[i].toLowerCase().includes(needle)) {
                console.log(`${path.relative(ROOT, file)}:${i + 1}:${lines[i]}`);
                printed += 1;
            }
        }
        if (printed >= 40)
            break;
    }
}
function check(label, fn) {
    try {
        const detail = fn();
        console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
        return true;
    }
    catch (error) {
        console.log(`FAIL  ${label}  ${error.message}`);
        return false;
    }
}
function requireOk(result, what) {
    if (result.error)
        throw new Error(result.error.message);
    if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || `${what} exited ${result.status}`).trim());
    }
    return result.stdout.trim();
}
function doctor(quick) {
    let failures = 0;
    const runCheck = (label, fn) => {
        if (!check(label, fn))
            failures += 1;
    };
    const wsl = !isWin && read('/proc/version').toLowerCase().includes('microsoft');
    runCheck('platform', () => (isWin ? 'Windows' : wsl ? 'WSL2' : 'Linux'));
    runCheck('claude on PATH', () => requireOk(claudeCapture(['--version']), 'claude --version'));
    runCheck('node on PATH', () => process.version);
    runCheck('git on PATH', () => requireOk(capture('git', ['--version']), 'git --version'));
    runCheck('inside a git repository', () => requireOk(capture('git', ['rev-parse', '--show-toplevel']), 'git rev-parse'));
    const hooksDir = path.join(ROOT, '.claude', 'hooks');
    if (fs.existsSync(hooksDir)) {
        for (const file of fs.readdirSync(hooksDir).filter((name) => name.endsWith('.mjs'))) {
            runCheck(`hooks: node --check ${path.basename(file, '.mjs')}`, () => requireOk(capture(process.execPath, ['--check', path.join(hooksDir, file)]), 'node --check'));
        }
    }
    const distDir = path.join(ROOT, 'dist');
    runCheck('dist: build output', () => {
        fs.accessSync(path.join(distDir, 'cli', 'main.js'), fs.constants.R_OK);
        return 'dist/cli/main.js';
    });
    const distHooks = path.join(distDir, 'hooks');
    if (fs.existsSync(distHooks)) {
        for (const file of fs.readdirSync(distHooks).filter((name) => name.endsWith('.js'))) {
            runCheck(`dist hooks: node --check ${path.basename(file, '.js')}`, () => requireOk(capture(process.execPath, ['--check', path.join(distHooks, file)]), 'node --check'));
        }
    }
    for (const [label, file] of [
        ['console: node --check server', 'dist/lib/console.js'],
        ['console: node --check cli', 'dist/cli/console-main.js'],
        ['cli: node --check main', 'dist/cli/main.js'],
        ['launcher: node --check cli', 'bin/hugin-cli.mjs'],
        ['launcher: node --check console', 'bin/hugin-console.mjs'],
    ]) {
        runCheck(label, () => requireOk(capture(process.execPath, ['--check', path.join(ROOT, file)]), 'node --check'));
    }
    runCheck('console: web assets', () => {
        // The Vite build lives in `web/dist`; fall back to `web/` before the first build.
        const builtIndex = path.join(ROOT, 'web', 'dist', 'index.html');
        const sourceIndex = path.join(ROOT, 'web', 'index.html');
        const used = fs.existsSync(builtIndex) ? builtIndex : fs.existsSync(sourceIndex) ? sourceIndex : null;
        if (!used)
            throw new Error('missing web/dist/index.html and web/index.html');
        fs.accessSync(used, fs.constants.R_OK);
        return path.relative(ROOT, used).replace(/\\/g, '/');
    });
    runCheck('.hugin/runs writable', () => {
        fs.mkdirSync(RUNS, { recursive: true });
        fs.accessSync(RUNS, fs.constants.W_OK);
        return RUNS;
    });
    runCheck('python on PATH', () => {
        for (const bin of ['python3', 'python']) {
            if (capture(bin, ['-c', 'print(1)']).status === 0)
                return bin;
        }
        throw new Error('neither python3 nor python runs (Windows ships a Store alias stub)');
    });
    runCheck('claude agents JSON', () => {
        const output = requireOk(claudeCapture(['agents', '--json', '--all']), 'claude agents');
        JSON.parse(output);
        return 'parsed';
    });
    runCheck('git worktree', () => {
        const output = requireOk(capture('git', ['worktree', 'list']), 'git worktree');
        return `${output.split(/\r?\n/).filter(Boolean).length} worktree(s)`;
    });
    if (!quick) {
        if (isWin) {
            console.log('SKIP  proxy 127.0.0.1:3425 (Windows)');
        }
        else {
            runCheck('proxy 127.0.0.1:3425', () => {
                requireOk(capture('curl', ['-sf', '-m', '3', 'http://127.0.0.1:3425']), 'proxy check');
                return 'reachable';
            });
        }
    }
    console.log(failures === 0 ? 'doctor: all checks passed' : `doctor: ${failures} check(s) failed`);
    console.log('If `claude --bg` is refused, run `ng start` once and accept the trust prompt.');
    return failures === 0;
}
switch (cmd) {
    case 'start':
        await start(rest);
        break;
    case 'dashboard':
        exitWith(claude(['agents', ...rest]));
        break;
    case 'console':
        if (rest.includes('--status')) {
            await consoleStatusCommand(rest);
            break;
        }
        if (rest.includes('--stop')) {
            consoleStopCommand();
            break;
        }
        exitWith(sh(process.execPath, [path.join(ROOT, 'bin', 'hugin-console.mjs'), ...rest]));
        break;
    case 'ps':
        exitWith(claude(['agents', '--json', '--all', ...rest]));
        break;
    case 'attach':
    case 'logs':
    case 'stop':
        if (!rest[0])
            fail(`usage: hugin ${cmd} <id|name>`);
        exitWith(claude([cmd, ...rest]));
        break;
    case 'new-run':
        newRun(rest[0]);
        break;
    case 'work':
        work(rest[0], rest[1], rest.slice(2));
        break;
    case 'collect':
        collect(rest[0], rest[1]);
        break;
    case 'checkpoint':
        checkpoint(rest[0], rest[1], rest.slice(2));
        break;
    case 'checkpoints':
        listCheckpoints(rest[0], rest.slice(1));
        break;
    case 'rollback':
        rollback(rest[0], rest[1], rest.slice(2));
        break;
    case 'memory':
        memory();
        break;
    case 'remember':
        remember(rest.join(' '));
        break;
    case 'recall':
        recall(rest.join(' '));
        break;
    case 'lang':
    case 'language':
        lang(rest[0]);
        break;
    case 'status':
        if (rest.includes('--json')) {
            await statusJson(rest);
            break;
        }
        if (rest.includes('--watch')) {
            const rawInterval = flagValue(rest, '--interval');
            const interval = rawInterval ? Number(rawInterval) : 5;
            if (!Number.isFinite(interval) || interval <= 0) {
                fail('usage: hugin status --watch [--interval <seconds>]');
            }
            await statusWatch(rest.includes('--all'), interval);
            break;
        }
        renderStatus(rest.includes('--all'));
        break;
    case 'doctor':
        process.exit(doctor(rest.includes('--quick')) ? 0 : 1);
        break;
    case 'help':
    case '-h':
    case '--help':
        usage();
        break;
    default:
        usage();
        process.exit(1);
}
