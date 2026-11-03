import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Resolve the main repository root, even when cwd is a git worktree.
 * Background sessions edit inside .claude/worktrees/<...>, while run
 * evidence lives in the main checkout. `--git-common-dir` points at the
 * main .git directory from either location.
 */
export function repoRoot(cwd) {
  if (process.env.HUGIN_REPO_ROOT) return path.resolve(process.env.HUGIN_REPO_ROOT);
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!common) return cwd;
    const abs = path.resolve(cwd, common);
    return path.basename(abs) === '.git' ? path.dirname(abs) : cwd;
  } catch {
    return cwd;
  }
}

export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

export async function readInput() {
  const raw = await readStdin();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function taskDescription(input) {
  return input.task_description ?? input.description ?? input.task?.description ?? '';
}

export function field(description, name) {
  const lines = String(description ?? '').split(/\r?\n/);
  const head = new RegExp(`^\\s*${name}\\s*:\\s*`, 'i');
  const anyField = /^\s*[A-Za-z][A-Za-z0-9 _-]*:\s*/;
  const index = lines.findIndex((line) => head.test(line));
  if (index === -1) return null;
  const first = lines[index].replace(head, '').trim();
  const rest = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    if (anyField.test(lines[i])) break;
    rest.push(lines[i]);
  }
  return [first, ...rest].join('\n').trim();
}

export function currentRunId(cwd) {
  if (process.env.HUGIN_RUN_DIR) return path.basename(path.resolve(process.env.HUGIN_RUN_DIR));
  try {
    return fs
      .readFileSync(path.join(repoRoot(cwd), '.hugin', 'CURRENT_RUN'), 'utf8')
      .trim();
  } catch {
    return '';
  }
}

export function runDir(cwd) {
  if (process.env.HUGIN_RUN_DIR) return path.resolve(process.env.HUGIN_RUN_DIR);
  const id = currentRunId(cwd);
  return id ? path.join(repoRoot(cwd), '.hugin', 'runs', id) : '';
}

export function logEvent(cwd, event, detail) {
  const dir = runDir(cwd);
  const target = dir
    ? path.join(dir, 'hooks.log')
    : path.join(repoRoot(cwd), '.hugin', 'hooks.log');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
  } catch {
    // Logging must never be the reason a session fails.
  }
}

export function fail(message) {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  process.exit(2);
}

export function ok() {
  process.exit(0);
}

export function isYes(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ''));
}
