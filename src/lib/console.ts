import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = process.env.HUGIN_ROOT
  ? path.resolve(process.env.HUGIN_ROOT)
  : path.resolve(HERE, '../..');

const LENSES = ['correctness', 'security', 'tests'];

export interface RunInfo {
  id: string;
  base: string | null;
  status: string | null;
  createdAt: string | null;
}

export interface Stage {
  key: string;
  label: string;
  action: string;
}

export interface ConsoleState {
  generatedAt: string;
  repo: string;
  runs: RunInfo[];
  run: any;
  brief: string;
  runNotes: string;
  finalReport: string;
  tasks: any[];
  attention: any[];
  gate: any;
  reviewBoard: any;
  reviewFiles: string[];
  memory: { index: string; lessons: string; decisions: string };
}

function safeName(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.includes('..')
  );
}

function cap(value: unknown, max = 1200): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function readText(file: string, max = 6000): string {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > max ? `${text.slice(0, max)}\n…` : text;
  } catch {
    return '';
  }
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readCurrentRun(root: string): string {
  return readText(path.join(root, '.hugin', 'CURRENT_RUN'), 200).trim();
}

export function listRuns(root = DEFAULT_ROOT): RunInfo[] {
  const dir = path.join(root, '.hugin', 'runs');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && safeName(entry.name))
    .map((entry) => {
      const meta = readJson(path.join(dir, entry.name, 'run.json'));
      return {
        id: entry.name,
        base: meta?.base ?? null,
        status: meta?.status ?? null,
        createdAt: meta?.created_at ?? meta?.createdAt ?? null,
      };
    })
    .sort((a, b) => String(b.createdAt ?? b.id).localeCompare(String(a.createdAt ?? a.id)));
}

function scanTaskDirs(runDir: string): { id: string }[] {
  if (!runDir) return [];
  const dir = path.join(runDir, 'tasks');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && safeName(entry.name))
      .map((entry) => ({ id: entry.name }));
  } catch {
    return [];
  }
}

function severityBucket(value: unknown): string {
  const severity = String(value ?? '').toLowerCase();
  if (severity === 'blocker') return 'critical';
  if (severity === 'major') return 'high';
  if (severity === 'minor') return 'low';
  return severity;
}

function readReview(runDir: string, taskId: string, lens: string): any {
  const data = readJson(path.join(runDir, 'reviews', `${taskId}-${lens}.json`));
  if (!data) return null;
  const findings = Array.isArray(data.findings)
    ? data.findings.map((finding: any) => ({
        id: cap(finding?.id, 80),
        severity: cap(finding?.severity, 20),
        file: cap(finding?.file, 300),
        line: Number.isFinite(finding?.line) ? finding.line : null,
        claim: cap(finding?.claim, 1200),
        evidence: cap(finding?.evidence, 1200),
        suggestion: cap(finding?.suggestion, 800),
      }))
    : [];
  return {
    lens: data.lens ?? lens,
    count: findings.length,
    high: findings.filter((finding: any) =>
      ['critical', 'high'].includes(severityBucket(finding.severity)),
    ).length,
    findings,
    checked: Array.isArray(data.checked) ? data.checked.map((item: any) => cap(item, 300)) : [],
    unverified: Array.isArray(data.unverified)
      ? data.unverified.map((item: any) => cap(item, 300))
      : [],
  };
}

function readVerdict(runDir: string, taskId: string): any {
  const candidates = [
    path.join(runDir, 'tasks', taskId, 'verdict.json'),
    path.join(runDir, 'reviews', `${taskId}-verdict.json`),
    path.join(runDir, 'reviews', `${taskId}-verify.json`),
  ];
  for (const file of candidates) {
    const data = readJson(file);
    if (data) {
      return {
        verdict: cap(data.verdict, 30) || 'INCOMPLETE',
        checks: Array.isArray(data.checks)
          ? data.checks.slice(0, 30).map((check: any) => ({
              cmd: cap(check?.cmd, 500),
              exit: Number.isFinite(check?.exit) ? check.exit : null,
              output: cap(check?.output, 800),
            }))
          : [],
        ac: Array.isArray(data.ac)
          ? data.ac.slice(0, 30).map((item: any) => ({
              criterion: cap(item?.criterion, 500),
              result: cap(item?.result, 40),
            }))
          : [],
        blockers: Array.isArray(data.blockers) ? data.blockers.map((item: any) => cap(item, 500)) : [],
        unverified: Array.isArray(data.unverified)
          ? data.unverified.map((item: any) => cap(item, 500))
          : [],
      };
    }
  }
  return null;
}

function deriveStage(
  task: any,
  handoff: any,
  verdict: any,
  reviews: any[],
  worker: any,
): Stage {
  const openFindings = reviews.reduce(
    (total: number, review: any) =>
      total +
      review.findings.filter((finding: any) =>
        ['critical', 'high', 'medium'].includes(severityBucket(finding.severity)),
      ).length,
    0,
  );
  if (worker?.state === 'blocked') {
    return {
      key: 'attention',
      label: 'Awaiting answer',
      action: `./bin/hugin attach ${worker.id || worker.name}`,
    };
  }
  if (worker?.state === 'failed' || task?.status === 'failed') {
    return {
      key: 'failed',
      label: 'Failed',
      action: `./bin/hugin logs ${worker?.id ?? '<id>'}`,
    };
  }
  if (task?.status === 'blocked' || handoff?.status === 'blocked') {
    return {
      key: 'blocked',
      label: 'Blocked',
      action: 'resolve the blocker, then re-dispatch',
    };
  }
  if (handoff?.status === 'complete' && verdict?.verdict === 'PASS' && openFindings === 0) {
    return {
      key: 'complete',
      label: 'Verified',
      action: 'ready for a human merge decision',
    };
  }
  if (handoff?.status === 'complete') {
    return {
      key: 'review',
      label: 'Awaiting review',
      action: openFindings > 0 ? 'inspect open findings' : 'dispatch reviewer + verifier',
    };
  }
  if (worker?.state === 'working' || ['working', 'dispatched'].includes(task?.status)) {
    return { key: 'working', label: 'Working', action: 'monitor' };
  }
  return { key: 'queued', label: 'Queued', action: 'dispatch an implementer' };
}

function hydrateTask(task: any, runDir: string, workers: any[]): any {
  const id = cap(task?.id ?? task?.task ?? '', 80);
  const safe = safeName(id);
  const handoff = safe && runDir ? readJson(path.join(runDir, 'tasks', id, 'handoff.json')) : null;
  const reviews = safe && runDir ? LENSES.map((lens) => readReview(runDir, id, lens)).filter(Boolean) : [];
  const verdict = safe && runDir ? readVerdict(runDir, id) : null;
  const worker =
    workers.find(
      (candidate: any) =>
        candidate.id === task?.worker ||
        candidate.name === task?.worker ||
        (id && typeof candidate.name === 'string' && candidate.name.includes(`-${id}-`)),
    ) ?? null;

  const commandsRun = Array.isArray(handoff?.commands_run)
    ? handoff.commands_run.slice(0, 30).map((command: any) => ({
        cmd: cap(command?.cmd, 600),
        exit: Number.isFinite(command?.exit) ? command.exit : null,
        log: cap(command?.log, 300),
      }))
    : [];

  const ac = Array.isArray(handoff?.ac)
    ? handoff.ac.slice(0, 30).map((item: any) => ({
        criterion: cap(item?.criterion, 500),
        proof: cap(item?.proof, 800),
      }))
    : [];

  const memoryCandidates = Array.isArray(handoff?.memory_candidates)
    ? handoff.memory_candidates.slice(0, 20).map((item: any) => ({
        text: cap(item?.text ?? item, 600),
        why: cap(item?.why, 400),
        scope: cap(item?.scope, 100),
      }))
    : [];

  const openFindings = reviews.reduce(
    (total: number, review: any) =>
      total +
      review.findings.filter((finding: any) =>
        ['critical', 'high', 'medium'].includes(severityBucket(finding.severity)),
      ).length,
    0,
  );

  const stage = deriveStage(task, handoff, verdict, reviews, worker);

  return {
    id,
    title: cap(task?.title ?? task?.goal ?? task?.description ?? id, 500),
    owner: cap(task?.owner ?? '', 100),
    status: cap(task?.status ?? handoff?.status ?? 'unknown', 40),
    stage,
    worker: worker
      ? {
          id: worker.id,
          name: worker.name,
          state: worker.state,
          waitingFor: worker.waitingFor,
        }
      : null,
    evidenceLabel: handoff
      ? `handoff ${handoff.status ?? '?'}${verdict ? ` · verdict ${verdict.verdict}` : ''}`
      : 'handoff missing',
    deps: Array.isArray(task?.deps) ? task.deps.map((dep: any) => cap(dep, 80)) : [],
    files: Array.isArray(task?.files) ? task.files.map((file: any) => cap(file, 300)) : [],
    handoff: handoff
      ? {
          status: cap(handoff.status, 40),
          branch: cap(handoff.branch, 200),
          worktree: cap(handoff.worktree, 400),
          filesChanged: Array.isArray(handoff.files_changed)
            ? handoff.files_changed.map((file: any) => cap(file, 300))
            : [],
          commandsRun,
          ac,
          residualRisks: Array.isArray(handoff.residual_risks)
            ? handoff.residual_risks.map((item: any) => cap(item, 500))
            : [],
          unverified: Array.isArray(handoff.unverified)
            ? handoff.unverified.map((item: any) => cap(item, 500))
            : [],
          memoryCandidates,
        }
      : null,
    reviews,
    verdict,
    openFindings,
  };
}

function normalizeGate(runDir: string): any {
  const data = readJson(path.join(runDir, 'reviews', 'gate.json'));
  if (!data) return null;
  const gate = data.gate ?? data;
  return {
    verdict: cap(gate.verdict, 30) || 'BLOCK',
    reasons: Array.isArray(gate.reasons) ? gate.reasons.map((item: any) => cap(item, 800)) : [],
    residualRisks: Array.isArray(gate.residual_risks)
      ? gate.residual_risks.map((item: any) => cap(item, 800))
      : [],
    testPassed: typeof data.test?.passed === 'boolean' ? data.test.passed : null,
  };
}

function normalizeReviewBoard(runDir: string): any {
  const data = readJson(path.join(runDir, 'reviews', 'review-board.json'));
  if (!data) return null;
  return {
    verdict: cap(data.verdict, 30) || 'BLOCK',
    summary: cap(data.summary, 1200),
    blockers: Array.isArray(data.blockers) ? data.blockers.map((item: any) => cap(item, 500)) : [],
  };
}

function collectAttention(
  tasks: any[],
  gate: any,
  workers: any[],
  workersError: string | null,
): any[] {
  const items: any[] = [];
  for (const task of tasks) {
    if (['attention', 'failed', 'blocked'].includes(task.stage.key)) {
      items.push({
        kind: task.stage.key,
        title: `${task.id} · ${task.title}`,
        detail: task.stage.label,
        action: task.stage.action,
      });
    } else if (task.openFindings > 0) {
      items.push({
        kind: 'findings',
        title: `${task.id} · ${task.openFindings} open finding(s)`,
        detail: 'review',
        action: 'inspect the findings',
      });
    }
  }

  for (const worker of workers) {
    if (!['blocked', 'failed'].includes(worker.state)) continue;
    const owned = tasks.some((task) => task.worker?.id === worker.id);
    if (owned) continue;
    items.push({
      kind: worker.state,
      title: worker.name || worker.id,
      detail: worker.waitingFor || `session ${worker.state}`,
      action: worker.state === 'blocked'
        ? `./bin/hugin attach ${worker.id || worker.name}`
        : `./bin/hugin logs ${worker.id || worker.name}`,
    });
  }

  if (gate?.verdict === 'BLOCK') {
    items.push({
      kind: 'gate',
      title: 'Merge gate is BLOCK',
      detail: gate.reasons[0] ?? '',
      action: 'inspect the gate reasons',
    });
  }

  if (workersError) {
    items.push({
      kind: 'system',
      title: 'claude agents unavailable',
      detail: workersError,
      action: 'check that claude is on PATH',
    });
  }

  return items;
}

export function buildState({
  root = DEFAULT_ROOT,
  runId,
  workers = [],
  workersError = null,
}: { root?: string; runId?: string; workers?: any[]; workersError?: string | null } = {}): ConsoleState {
  const runs = listRuns(root);
  const stored = readCurrentRun(root);
  const requested = runId && safeName(runId) ? runId : '';
  const effective =
    (requested && runs.some((run) => run.id === requested) ? requested : '') ||
    (safeName(stored) && runs.some((run) => run.id === stored) ? stored : '') ||
    runs[0]?.id ||
    null;

  const runDir = effective ? path.join(root, '.hugin', 'runs', effective) : '';
  const meta = runDir ? readJson(path.join(runDir, 'run.json')) : null;
  const board = runDir ? readJson(path.join(runDir, 'board.json')) : null;
  const boardTasks: any[] = Array.isArray(board?.tasks) ? board.tasks : [];
  const tasks = (boardTasks.length > 0 ? boardTasks : scanTaskDirs(runDir)).map((task: any) =>
    hydrateTask(task, runDir, workers),
  );

  const memoryDir = path.join(root, '.hugin', 'memory');
  let reviewFiles: string[] = [];
  if (runDir) {
    try {
      reviewFiles = fs.readdirSync(path.join(runDir, 'reviews')).map((name) => cap(name, 200));
    } catch {
      reviewFiles = [];
    }
  }

  const gate = runDir ? normalizeGate(runDir) : null;

  return {
    generatedAt: new Date().toISOString(),
    repo: root,
    runs,
    run: effective
      ? {
          id: effective,
          base: meta?.base ?? null,
          status: meta?.status ?? null,
          createdAt: meta?.created_at ?? meta?.createdAt ?? null,
        }
      : null,
    brief: runDir ? readText(path.join(runDir, 'brief.md'), 6000) : '',
    runNotes: runDir ? readText(path.join(runDir, 'memory.md'), 4000) : '',
    finalReport: runDir ? readText(path.join(runDir, 'final-report.md'), 6000) : '',
    tasks,
    attention: collectAttention(tasks, gate, workers, workersError),
    gate,
    reviewBoard: runDir ? normalizeReviewBoard(runDir) : null,
    reviewFiles,
    memory: {
      index: readText(path.join(memoryDir, 'INDEX.md'), 8000),
      lessons: readText(path.join(memoryDir, 'lessons.md'), 4000),
      decisions: readText(path.join(memoryDir, 'decisions.md'), 3000),
    },
  };
}

export async function readWorkers(): Promise<{ workers: any[]; error: string | null }> {
  try {
    const { stdout } = await execFileAsync('claude', ['agents', '--json', '--all'], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const all = JSON.parse(stdout);
    const workers = (Array.isArray(all) ? all : [])
      .filter((worker: any) => typeof worker?.name === 'string' && worker.name.startsWith('hugin-'))
      .map((worker: any) => ({
        id: cap(worker.id, 100),
        name: cap(worker.name, 200),
        state: cap(worker.state ?? worker.status ?? 'unknown', 40),
        waitingFor: cap(worker.waitingFor, 300),
        cwd: cap(worker.cwd, 400),
        startedAt: cap(worker.startedAt, 60),
      }));
    return { workers, error: null };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    const message =
      failure?.code === 'ENOENT'
        ? 'claude not found on PATH'
        : cap(failure?.message ?? String(error), 500);
    return { workers: [], error: message };
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function serveStatic(
  root: string,
  pathname: string,
  res: ServerResponse,
  method: string | undefined,
): void {
  const webRoot = path.join(root, 'web');
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'bad request');
    return;
  }
  const relative = decoded === '/' ? '/index.html' : decoded;
  const target = path.normalize(path.join(webRoot, relative));
  if (target !== webRoot && !target.startsWith(`${webRoot}${path.sep}`)) {
    sendText(res, 403, 'forbidden');
    return;
  }
  let body: Buffer;
  try {
    body = fs.readFileSync(target);
  } catch {
    sendText(res, 404, 'not found');
    return;
  }
  const headers = {
    'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  };
  res.writeHead(200, headers);
  res.end(method === 'HEAD' ? undefined : body);
}

export function createConsoleServer({
  root = DEFAULT_ROOT,
  host = '127.0.0.1',
  port = 8787,
}: { root?: string; host?: string; port?: number } = {}): http.Server {
  return http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendText(res, 400, 'bad request');
      return;
    }

    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, host, port });
      return;
    }

    if (url.pathname === '/api/runs') {
      sendJson(res, 200, { runs: listRuns(root) });
      return;
    }

    if (url.pathname === '/api/state') {
      const { workers, error } = await readWorkers();
      const state = buildState({
        root,
        runId: url.searchParams.get('run') ?? undefined,
        workers,
        workersError: error,
      });
      sendJson(res, 200, { ...state, workers, workersError: error });
      return;
    }

    serveStatic(root, url.pathname, res, req.method);
  });
}
