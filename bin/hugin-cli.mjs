#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
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

function read(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch {
    return fallback;
  }
}

function readJson(file) {
  try {
    return JSON.parse(read(file));
  } catch {
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

function usage() {
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
  hugin memory                Show the project memory index and recent lessons
  hugin remember <text>       Append a dated lesson to .hugin/memory/lessons.md
  hugin recall <query>        Search .hugin/memory and run evidence
  hugin status [--all]        Show current run and Hugin background sessions
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

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function newRun(id) {
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

function status(showAll) {
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
      const counts = {};
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
  let agents;
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

  const hugin = agents.filter((agent) => String(agent.name ?? '').startsWith('hugin-'));
  const visible = hugin.filter((agent) => {
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
  if (!text) fail('usage: hugin remember <text>');
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

function recall(query) {
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

function check(label, fn) {
  try {
    const detail = fn();
    console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
    return true;
  } catch (error) {
    console.log(`FAIL  ${label}  ${error.message}`);
    return false;
  }
}

function requireOk(result, what) {
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${what} exited ${result.status}`).trim());
  }
  return result.stdout.trim();
}

function doctor(quick) {
  let failures = 0;
  const runCheck = (label, fn) => {
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

  for (const [label, file] of [
    ['console: node --check server', 'lib/console.mjs'],
    ['console: node --check cli', 'bin/hugin-console.mjs'],
    ['cli: node --check hugin-cli', 'bin/hugin-cli.mjs'],
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
