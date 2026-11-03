import fs from 'node:fs';
import path from 'node:path';
import { readInput, repoRoot, currentRunId } from './lib.mjs';

function readCapped(file, max) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}\n…` : text;
  } catch {
    return '';
  }
}

function boardSummary(file) {
  try {
    const board = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tasks = Array.isArray(board.tasks) ? board.tasks : [];
    return tasks
      .slice(0, 12)
      .map((task) => {
        const id = task.id ?? '?';
        const status = task.status ?? '?';
        const title = task.title ?? task.goal ?? '';
        const owner = task.owner ?? '-';
        return `- ${id} [${status}] ${title} (${owner})`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

const input = await readInput();
const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const root = repoRoot(cwd);

if (!fs.existsSync(path.join(root, '.hugin'))) {
  process.exit(0);
}

const run = currentRunId(cwd);
const parts = ['Hugin memory (injected at session start)', `repo: ${root}`];

if (run) {
  const dir = path.join(root, '.hugin', 'runs', run);
  parts.push(`current run: ${run}`);

  const runJson = readCapped(path.join(dir, 'run.json'), 500);
  if (runJson) parts.push(`run.json: ${runJson.replace(/\s+/g, ' ')}`);

  const brief = readCapped(path.join(dir, 'brief.md'), 2500);
  if (brief) parts.push('', '## Run brief', brief);

  const notes = readCapped(path.join(dir, 'memory.md'), 1200);
  if (notes) parts.push('', '## Run notes', notes);

  const board = boardSummary(path.join(dir, 'board.json'));
  if (board) parts.push('', '## Board', board);
} else {
  parts.push('current run: none');
}

const lessons = readCapped(path.join(root, '.hugin', 'memory', 'lessons.md'), 1200);
if (lessons) parts.push('', '## Recent lessons', lessons);

parts.push(
  '',
  'Project memory index: .hugin/memory/INDEX.md (also loaded through CLAUDE.md).',
  'Run evidence is authoritative. Memory notes are context, not proof.',
);

const text = parts.join('\n');
const capped = text.length > 9000 ? `${text.slice(0, 9000)}\n…` : text;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: capped,
    },
  }),
);
