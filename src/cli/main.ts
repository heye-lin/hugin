#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as checkpoints from '../lib/checkpoints.js';

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

function sh(
  bin: string,
  args: string[],
  opts: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  return spawnSync(bin, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}

type CaptureOptions = { cwd?: string; timeout?: number };

function capture(
  bin: string,
  args: string[],
  opts: CaptureOptions = {},
): SpawnSyncReturns<string> {
  return spawnSync(bin, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
    ...opts,
  });
}

function claude(
  args: string[],
  opts: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  return sh(CLAUDE, args, opts);
}

function claudeCapture(args: string[]): SpawnSyncReturns<string> {
  return capture(CLAUDE, args);
}

function read(file: string, fallback = ''): string {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch {
    return fallback;
  }
}

function readJson(file: string): any {
  try {
    return JSON.parse(read(file));
  } catch {
    return null;
  }
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function exitWith(result: SpawnSyncReturns<string | Buffer>): never {
  if (result.error) {
    console.error(`failed to run: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function flagValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  return index === -1 ? '' : (args[index + 1] ?? '');
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireSafeRunTask(run: string | undefined, task: string | undefined): void {
  const pairs: Array<[string, string | undefined]> = [
    ['run', run],
    ['task', task],
  ];
  for (const [label, value] of pairs) {
    if (!SAFE_NAME.test(value ?? '') || (value ?? '').includes('..')) {
      fail(`invalid ${label}: ${JSON.stringify(value)} (allowed: letters, digits, dot, underscore, dash)`);
    }
  }
}

function inside(base: string, target: string): boolean {
  const root = path.resolve(base);
  const candidate = path.resolve(target);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return isWin ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function taskWorktree(run: string, task: string): string {
  const fallback = path.join(WORKTREES, `${run}-${task}`);
  const recorded = read(path.join(RUNS, run, 'tasks', task, 'worktree.txt')).trim();
  if (!recorded) return fallback;
  return inside(WORKTREES, recorded) ? recorded : fallback;
}

/**
 * A directory counts as a worktree only when it is the top level of its own
 * checkout. Plain subdirectories of the repo also make `rev-parse --git-dir`
 * succeed, so that command alone would treat any directory as a worktree.
 */
function isWorktree(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const top = capture('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  if (top.status !== 0) return false;
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
function pruneStaleWorktree(dir: string): boolean {
  if (!fs.existsSync(dir) || isWorktree(dir)) return false;
  const probe = capture('git', ['-C', dir, 'rev-parse', '--git-dir']);
  const reason = `${probe.stderr ?? ''}${probe.stdout ?? ''}`;
  if (!/not a git repository|cannot change to|no such file or directory/i.test(reason)) {
    console.error(`left worktree in place (unexpected git error): ${reason.trim()}`);
    return false;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parked = `${dir}.stale-${stamp}`;
  fs.renameSync(dir, parked);
  // `git worktree prune` has no per-path form. It only drops admin entries whose
  // worktree directory is gone or whose gitdir link is broken; it never deletes
  // files, so another platform's registrations can be re-added harmlessly.
  capture('git', ['worktree', 'prune']);
  console.error(`moved unusable worktree aside: ${parked}`);
  console.error('  inspect it before deleting; its .git link points at another platform');
  return true;
}

function work(run: string | undefined, task: string | undefined, args: string[]): void {
  if (!run || !task) fail('usage: hugin work <run> <task> [--base <sha>] [--branch <name>]');
  requireSafeRunTask(run, task);
  const meta = readJson(path.join(RUNS, run, 'run.json'));
  const base = flagValue(args, '--base') || meta?.base || 'HEAD';
  const branch = flagValue(args, '--branch') || `hugin/${task}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) {
    fail(`invalid branch: ${JSON.stringify(branch)}`);
  }
  const dir = taskWorktree(run, task);
  if (!inside(WORKTREES, dir)) fail(`refusing worktree path outside .claude/worktrees: ${dir}`);
  const pointer = path.join(RUNS, run, 'tasks', task, 'worktree.txt');

  if (pruneStaleWorktree(dir)) {
    console.error(`pruned stale worktree: ${dir}`);
  }

  if (isWorktree(dir)) {
    write(pointer, `${dir}\n`);
    console.log(dir);
    console.log(`branch: ${requireOk(capture('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']), 'git branch').trim()}`);
    const current = requireOk(capture('git', ['-C', dir, 'rev-parse', 'HEAD']), 'git head').trim();
    console.log(`head:   ${current.slice(0, 7)}`);
    console.log('(reused existing worktree)');
    if (flagValue(args, '--base')) {
      const wanted = capture('git', ['rev-parse', '--verify', `${flagValue(args, '--base')}^{commit}`]);
      if (wanted.status === 0 && wanted.stdout.trim() !== current) {
        console.error(`warning: existing worktree is at ${current.slice(0, 7)}, not --base ${flagValue(args, '--base')}`);
      }
    }
    return;
  }

  const rev = capture('git', ['rev-parse', '--verify', `${base}^{commit}`]);
  if (rev.status !== 0) fail(`unknown base commit: ${base}`);
  const sha = rev.stdout.trim();
  const branchExists =
    capture('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
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
    console.error(
      `warning: branch ${branch} is at ${headSha.slice(0, 7)}, not the requested base ${base} (${sha.slice(0, 7)})`,
    );
  }
}

/**
 * Copy the worker's handoff out of its worktree. Reviews and verdicts are NOT
 * collected: the implementer can write inside its worktree, so importing them
 * would let it forge reviewer/verifier evidence. The Master stages those from
 * the reviewer's own final message instead.
 */
function collect(run: string | undefined, task: string | undefined): void {
  if (!run || !task) fail('usage: hugin collect <run> <task>');
  requireSafeRunTask(run, task);

  const worktree = taskWorktree(run, task);
  if (!inside(WORKTREES, worktree)) {
    fail(`refusing to read evidence outside .claude/worktrees: ${worktree}`);
  }
  const relative = path.join('tasks', task, 'handoff.json');
  const from = path.join(worktree, '.hugin', 'runs', run, relative);
  const to = path.join(RUNS, run, relative);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(from);
  } catch {
    fail(
      `worktree evidence not found: ${from}\nRun 'hugin work ${run} ${task}' first, and make sure the worker wrote its handoff inside the worktree.`,
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`handoff must be a regular file, not a link or directory: ${from}`);
  }

  const text = read(from);
  let handoff: any;
  try {
    handoff = JSON.parse(text);
  } catch {
    fail(`handoff is not valid JSON: ${from}`);
  }

  const branch = typeof handoff.branch === 'string' ? handoff.branch.trim() : '';
  if (branch) {
    const exists =
      capture('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
    if (!exists) fail(`handoff.branch does not exist: ${branch}`);
  }
  const declared = typeof handoff.worktree === 'string' ? handoff.worktree.trim() : '';
  if (declared && !samePath(declared, worktree)) {
    console.error(`warning: handoff.worktree (${declared}) differs from the worktree on disk (${worktree})`);
  }

  write(to, text);
  const copied = [relative];
  console.log(`collected 1 file into .hugin/runs/${run}:`);
  console.log(`  ${relative}`);

  const logs: string[] = [];
  for (const entry of Array.isArray(handoff.commands_run) ? handoff.commands_run : []) {
    const ref = typeof entry?.log === 'string' ? entry.log.trim().replace(/\\/g, '/') : '';
    if (!ref || !ref.startsWith(`.hugin/runs/${run}/logs/`)) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(ref.slice(`.hugin/runs/${run}/logs/`.length))) continue;
    const logFrom = path.join(worktree, ref);
    const logTo = path.join(ROOT, ref);
    if (!inside(RUNS, logTo)) {
      console.error(`warning: referenced log is outside .hugin/runs: ${ref}`);
      continue;
    }
    let logStat: fs.Stats;
    try {
      logStat = fs.lstatSync(logFrom);
    } catch {
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
    write(logTo, fs.readFileSync(logFrom, 'utf8'));
    logs.push(ref);
  }
  for (const ref of logs) console.log(`  ${ref}`);

  if (handoff.status !== 'complete') {
    console.error(`handoff status: ${handoff.status ?? '(missing)'} — TaskCompleted will block.`);
    process.exit(1);
  }
  const criteria = Array.isArray(handoff.ac) ? handoff.ac.length : 0;
  const changed = Array.isArray(handoff.files_changed) ? handoff.files_changed.length : 0;
  console.log(`handoff: status=complete ac=${criteria} files_changed=${changed}`);
}

function checkpointContext(): checkpoints.CheckpointContext {
  return { root: ROOT, runsDir: RUNS, worktreesDir: WORKTREES };
}

function checkpoint(run: string | undefined, task: string | undefined, args: string[]): void {
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
    } else if (result.pushError) {
      console.error(`  push:   failed — ${result.pushError}`);
    } else {
      console.log(`  push:   origin ${entry.branch} + ${entry.tag}`);
    }
    if (result.pushError) process.exit(1);
  } catch (error) {
    fail((error as Error).message);
  }
}

function listCheckpoints(run: string | undefined, args: string[]): void {
  if (!run) fail('usage: hugin checkpoints <run> [--json]');
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
      console.log(
        `  ${entry.task.padEnd(12)} ${entry.commit.slice(0, 7)}  ${entry.tag.padEnd(28)} ${entry.created_at}  ${pushed}`,
      );
    }
  } catch (error) {
    fail((error as Error).message);
  }
}

function rollback(run: string | undefined, task: string | undefined, args: string[]): void {
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
  } catch (error) {
    fail((error as Error).message);
  }
}

function usage(): void {
  console.log(`Hugin

Usage:
  hugin start                 Start the master Claude session in this repo
  hugin dashboard             Open the background-agent dashboard (claude agents)
  hugin console [--port N]    Serve the read-only web console on 127.0.0.1
  hugin ps [--all]            Print background sessions as JSON
  hugin attach <id|name>      Attach this terminal to a background session
  hugin logs <id|name>        Print recent output of a background session
  hugin stop <id|name>        Stop a background session
  hugin new-run [run-id]      Create .hugin/runs/<run-id> and set CURRENT_RUN
  hugin work <run> <task>     Create or reuse the task's isolated worktree
  hugin collect <run> <task>  Copy handoff/review/verdict out of that worktree
  hugin checkpoint <run> <task> [--note <text>] [--no-push]
                              Commit and tag the task worktree, record the run ledger
  hugin checkpoints <run> [--json]
                              List the run's recorded checkpoints
  hugin rollback <run> <task> [--branch <name>] [--dry-run]
                              Create a restore branch at the task's checkpoint
  hugin memory                Show the project memory index and recent lessons
  hugin remember <text>       Append a dated lesson to .hugin/memory/lessons.md
  hugin recall <query>        Search .hugin/memory and run evidence
  hugin status [--all]        Show current run and Hugin background sessions
  hugin lang [zh|en|<code>]   Show or set the run language (default zh-CN)
  hugin doctor [--quick]      Check the environment (no mutating actions)
  hugin help                  Show this help`);
}

function currentLanguage(): string {
  const config = readJson(CONFIG);
  return typeof config?.language === 'string' && config.language.trim()
    ? config.language.trim()
    : 'zh-CN';
}

function setLanguage(code: string): void {
  const config = readJson(CONFIG) || {};
  config.language = code;
  write(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
}

function lang(value: string | undefined): void {
  if (!value) {
    console.log(currentLanguage());
    return;
  }
  const key = String(value).toLowerCase();
  let code: string;
  if (['zh', 'zh-cn', 'cn', 'chinese', '中文'].includes(key)) {
    code = 'zh-CN';
  } else if (['en', 'en-us', 'english', '英文', '英语'].includes(key)) {
    code = 'en-US';
  } else if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) {
    code = value;
  } else {
    fail('usage: hugin lang [zh|en|<bcp47-code>]');
  }
  setLanguage(code);
  console.log(`language: ${code}`);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function newRun(id: string | undefined): void {
  const run = id || stamp();
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
  write(
    path.join(dir, 'run.json'),
    `${JSON.stringify({ run, base, created_at: new Date().toISOString(), status: 'active' }, null, 2)}\n`,
  );
  write(CURRENT_RUN, `${run}\n`);
  console.log(run);
}

function status(showAll: boolean): void {
  const run = read(CURRENT_RUN).trim();
  console.log(`repo: ${ROOT}`);
  if (!isWin) {
    const win = capture('wslpath', ['-w', ROOT]);
    if (win.status === 0 && win.stdout.trim()) console.log(`win:  ${win.stdout.trim()}`);
  }
  console.log(`run:  ${run || '<none>'}`);
  console.log(`lang: ${currentLanguage()}`);

  if (run) {
    const meta = readJson(path.join(RUNS, run, 'run.json'));
    if (meta) {
      console.log(
        `      ${meta.status ?? 'unknown'}  base=${meta.base ?? '-'}  created=${meta.created_at ?? '-'}`,
      );
    }
    const board = readJson(path.join(RUNS, run, 'board.json'));
    if (Array.isArray(board?.tasks) && board.tasks.length > 0) {
      const counts: Record<string, number> = {};
      for (const task of board.tasks) {
        const state = task.status ?? 'unknown';
        counts[state] = (counts[state] ?? 0) + 1;
      }
      const summary = Object.entries(counts)
        .map(([state, count]) => `${state}=${count}`)
        .join(', ');
      console.log(`tasks: ${board.tasks.length} total — ${summary}`);
    }
  }
  console.log();

  console.log(`background sessions (${showAll ? 'all' : 'active'}):`);
  const result = claudeCapture(['agents', '--json', '--all']);
  if (result.error) {
    console.log('  (claude not runnable)');
    return;
  }
  let agents: any;
  try {
    agents = JSON.parse(result.stdout);
  } catch {
    console.log('  (unavailable)');
    if (result.stderr.trim()) console.log(`  ${result.stderr.trim()}`);
    return;
  }
  if (!Array.isArray(agents)) {
    console.log('  (unexpected JSON)');
    return;
  }

  const hugin = agents.filter((agent: any) => String(agent.name ?? '').startsWith('hugin-'));
  const visible = hugin.filter((agent: any) => {
    const state = String(agent.state ?? agent.status ?? '');
    return showAll || state !== 'stopped';
  });

  if (visible.length === 0) {
    console.log('  (none)');
    const hidden = hugin.length - visible.length;
    if (!showAll && hidden > 0) {
      console.log(`  ${hidden} stopped session(s) hidden — use 'ng status --all'`);
    }
    return;
  }

  for (const agent of visible) {
    const id = String(agent.id ?? '-').padEnd(12);
    const state = String(agent.state ?? agent.status ?? '-').padEnd(9);
    const name = String(agent.name ?? '-').padEnd(34);
    console.log(`  ${id} ${state} ${name} ${agent.waitingFor ?? '-'}`);
  }
}

function memory(): void {
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

function remember(text: string): void {
  if (!text) fail('usage: hugin remember <text>');
  const file = path.join(HUGIN, 'memory', 'lessons.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `- ${new Date().toISOString().slice(0, 10)}: ${text}\n`);
  console.log(`remembered: ${text}`);
  console.log('file: .hugin/memory/lessons.md');
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(md|json)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function recall(query: string): void {
  if (!query) fail('usage: hugin recall <query>');
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
    if (printed >= 40) break;
  }
}

function check(label: string, fn: () => string | void): boolean {
  try {
    const detail = fn();
    console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
    return true;
  } catch (error) {
    console.log(`FAIL  ${label}  ${(error as Error).message}`);
    return false;
  }
}

function requireOk(result: SpawnSyncReturns<string>, what: string): string {
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${what} exited ${result.status}`).trim());
  }
  return result.stdout.trim();
}

function doctor(quick: boolean): boolean {
  let failures = 0;
  const runCheck = (label: string, fn: () => string | void) => {
    if (!check(label, fn)) failures += 1;
  };

  const wsl = !isWin && read('/proc/version').toLowerCase().includes('microsoft');
  runCheck('platform', () => (isWin ? 'Windows' : wsl ? 'WSL2' : 'Linux'));
  runCheck('claude on PATH', () => requireOk(claudeCapture(['--version']), 'claude --version'));
  runCheck('node on PATH', () => process.version);
  runCheck('git on PATH', () => requireOk(capture('git', ['--version']), 'git --version'));
  runCheck('inside a git repository', () =>
    requireOk(capture('git', ['rev-parse', '--show-toplevel']), 'git rev-parse'),
  );

  const hooksDir = path.join(ROOT, '.claude', 'hooks');
  if (fs.existsSync(hooksDir)) {
    for (const file of fs.readdirSync(hooksDir).filter((name) => name.endsWith('.mjs'))) {
      runCheck(`hooks: node --check ${path.basename(file, '.mjs')}`, () =>
        requireOk(capture(process.execPath, ['--check', path.join(hooksDir, file)]), 'node --check'),
      );
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
      runCheck(`dist hooks: node --check ${path.basename(file, '.js')}`, () =>
        requireOk(capture(process.execPath, ['--check', path.join(distHooks, file)]), 'node --check'),
      );
    }
  }

  for (const [label, file] of [
    ['console: node --check server', 'dist/lib/console.js'],
    ['console: node --check cli', 'dist/cli/console-main.js'],
    ['cli: node --check main', 'dist/cli/main.js'],
    ['launcher: node --check cli', 'bin/hugin-cli.mjs'],
    ['launcher: node --check console', 'bin/hugin-console.mjs'],
  ]) {
    runCheck(label, () =>
      requireOk(capture(process.execPath, ['--check', path.join(ROOT, file)]), 'node --check'),
    );
  }

  runCheck('console: web assets', () => {
    for (const file of ['web/index.html', 'web/app.css', 'web/app.js']) {
      fs.accessSync(path.join(ROOT, file), fs.constants.R_OK);
    }
    return 'index.html, app.css, app.js';
  });

  runCheck('.hugin/runs writable', () => {
    fs.mkdirSync(RUNS, { recursive: true });
    fs.accessSync(RUNS, fs.constants.W_OK);
    return RUNS;
  });

  runCheck('python on PATH', () => {
    for (const bin of ['python3', 'python']) {
      if (capture(bin, ['-c', 'print(1)']).status === 0) return bin;
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
    } else {
      runCheck('proxy 127.0.0.1:3425', () => {
        requireOk(
          capture('curl', ['-sf', '-m', '3', 'http://127.0.0.1:3425']),
          'proxy check',
        );
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
    exitWith(claude(rest));
    break;
  case 'dashboard':
    exitWith(claude(['agents', ...rest]));
    break;
  case 'console':
    exitWith(sh(process.execPath, [path.join(ROOT, 'bin', 'hugin-console.mjs'), ...rest]));
    break;
  case 'ps':
    exitWith(claude(['agents', '--json', '--all', ...rest]));
    break;
  case 'attach':
  case 'logs':
  case 'stop':
    if (!rest[0]) fail(`usage: hugin ${cmd} <id|name>`);
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
    status(rest.includes('--all'));
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
