import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { claudeBinary } from './claude.js';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = process.env.HUGIN_ROOT
  ? path.resolve(process.env.HUGIN_ROOT)
  : path.resolve(HERE, '../..');

export const DEFAULT_CONSOLE_PORT = 8787;

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

/** Machine-readable roll-up shared by `hugin status --json` and `/api/state`. */
export interface SummaryCounts {
  running: number;
  queued: number;
  review: number;
  blocked: number;
  complete: number;
}

export interface QueueItem {
  id: string;
  title: string;
  owner: string;
  deps: string[];
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
  summary: SummaryCounts;
  queue: QueueItem[];
  attention: any[];
  gate: any;
  reviewBoard: any;
  reviewFiles: string[];
  memory: { index: string; lessons: string; decisions: string };
}

export interface ConsolePidInfo {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
}

export interface ConsoleStatus {
  running: boolean;
  pid: number | null;
  port: number;
  url: string;
  /** A pidfile existed but its process is gone; the file was removed. */
  stale: boolean;
}

export interface ConsoleDeps {
  isAlive?: (pid: number) => boolean;
  health?: (port: number) => boolean | Promise<boolean>;
  /** Injectable so tests can exercise stop logic without signalling a real pid. */
  kill?: (pid: number) => void;
}

export interface EnsureConsoleDeps extends ConsoleDeps {
  spawn?: (port: number) => number | null;
}

export interface EnsureConsoleResult extends ConsoleStatus {
  started: boolean;
  error?: string;
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
  // A board that already handed the task to review is a real review stage even
  // before the handoff lands; otherwise the task table and the summary counts
  // would disagree about the same row.
  if (task?.status === 'review') {
    return {
      key: 'review',
      label: 'Awaiting review',
      action: 'dispatch reviewer + verifier',
    };
  }
  if (worker?.state === 'working' || ['working', 'dispatched'].includes(task?.status)) {
    return { key: 'working', label: 'Working', action: 'monitor' };
  }
  return { key: 'queued', label: 'Queued', action: 'dispatch an implementer' };
}

function hydrateTask(task: any, runDir: string, workers: any[], runId: string | null = null): any {
  const id = cap(task?.id ?? task?.task ?? '', 80);
  const safe = safeName(id);
  const handoff = safe && runDir ? readJson(path.join(runDir, 'tasks', id, 'handoff.json')) : null;
  const reviews = safe && runDir ? LENSES.map((lens) => readReview(runDir, id, lens)).filter(Boolean) : [];
  const verdict = safe && runDir ? readVerdict(runDir, id) : null;
  // Worker names encode `hugin-<run>-<task>-<role>`, so a name heuristic is only
  // safe once it is scoped to this run: another run's `hugin-other-T1-impl` must
  // never drive this run's T1 stage. Without a run id, keep the loose heuristic.
  const workerPrefix = runId ? `hugin-${runId}-` : '';
  const worker =
    workers.find(
      (candidate: any) =>
        candidate.id === task?.worker ||
        candidate.name === task?.worker ||
        (id &&
          typeof candidate.name === 'string' &&
          candidate.name.includes(`-${id}-`) &&
          (!workerPrefix || candidate.name.startsWith(workerPrefix))),
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
    // The board's own status, kept apart from the handoff fallback above so the
    // summary can tell an explicit "complete" from "handoff complete, not verified".
    boardStatus: cap(task?.status ?? '', 40),
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

/**
 * Whether a dependency is done enough to unblock its dependents. A board entry
 * marked `complete` is the Master's dispatch signal, so it counts here even
 * before the evidence is verified; the summary counts stay stricter and follow
 * the task stage instead.
 */
function taskIsComplete(task: any): boolean {
  if (String(task?.boardStatus ?? task?.status ?? '') === 'complete') return true;
  return task?.handoff?.status === 'complete' && task?.verdict?.verdict === 'PASS';
}

/**
 * Roll a run up into the five counts the terminal and the web console share.
 * Worker counts are scoped to this run's session names (`hugin-<run>-…`);
 * `queued` is board order, filtered to pending tasks whose deps are all complete.
 *
 * `review` and `complete` are read from each task's stage — the same value the
 * task table shows — so a board status alone can never claim a task is verified
 * and one task is never counted in two buckets.
 */
export function summarizeTasks(
  tasks: any[],
  workers: any[] = [],
  runId: string | null = null,
): { counts: SummaryCounts; queue: QueueItem[] } {
  const prefix = runId ? `hugin-${runId}-` : 'hugin-';
  const scoped = workers.filter(
    (worker) => typeof worker?.name === 'string' && worker.name.startsWith(prefix),
  );
  const workerState = (worker: any) => String(worker?.state ?? worker?.status ?? '');

  const counts: SummaryCounts = {
    running: scoped.filter((worker) => workerState(worker) === 'working').length,
    queued: 0,
    review: 0,
    blocked: scoped.filter((worker) => workerState(worker) === 'blocked').length,
    complete: 0,
  };

  const byId = new Map<string, any>();
  for (const task of tasks) byId.set(String(task?.id ?? ''), task);

  const queue: QueueItem[] = [];
  for (const task of tasks) {
    const stage = String(task?.stage?.key ?? '');
    if (stage === 'complete') {
      counts.complete += 1;
      continue;
    }
    if (stage === 'review') {
      counts.review += 1;
      continue;
    }
    // `queued` keeps its dispatch meaning: a pending board task whose deps are
    // all complete. Review/complete tasks were already claimed above, so one
    // task never lands in two buckets.
    if (String(task?.boardStatus ?? '') !== 'pending') continue;
    const deps = Array.isArray(task?.deps) ? task.deps.map((dep: any) => String(dep)) : [];
    const ready = deps.every((dep: string) => {
      const target = byId.get(dep);
      return Boolean(target) && taskIsComplete(target);
    });
    if (!ready) continue;
    counts.queued += 1;
    queue.push({
      id: String(task?.id ?? ''),
      title: String(task?.title ?? task?.id ?? ''),
      owner: String(task?.owner ?? ''),
      deps,
    });
  }

  return { counts, queue };
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
    hydrateTask(task, runDir, workers, effective),
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

  const { counts: summary, queue } = summarizeTasks(tasks, workers, effective);

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
    summary,
    queue,
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

export interface ReadWorkersDeps {
  /** Injectable so tests can assert the shared executable without spawning. */
  exec?: (bin: string, args: string[]) => Promise<{ stdout: string }>;
}

export async function readWorkers(
  deps: ReadWorkersDeps = {},
): Promise<{ workers: any[]; error: string | null }> {
  const exec =
    deps.exec ??
    ((bin: string, args: string[]) =>
      execFileAsync(bin, args, {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      }));
  try {
    const { stdout } = await exec(claudeBinary(), ['agents', '--json', '--all']);
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

export function consolePidPath(root = DEFAULT_ROOT): string {
  return path.join(root, '.hugin', 'console.pid');
}

function readConsolePid(root = DEFAULT_ROOT): ConsolePidInfo | null {
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(consolePidPath(root), 'utf8'));
  } catch {
    return null;
  }
  const pid = Number(data?.pid);
  const port = Number(data?.port);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    pid,
    port,
    url: typeof data?.url === 'string' && data.url ? data.url : `http://127.0.0.1:${port}`,
    startedAt: typeof data?.startedAt === 'string' ? data.startedAt : '',
  };
}

export function writeConsolePid(root: string, info: ConsolePidInfo): void {
  const file = consolePidPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`);
}

export function removeConsolePid(root = DEFAULT_ROOT): void {
  try {
    fs.rmSync(consolePidPath(root));
  } catch {
    // Already gone.
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export async function checkConsoleHealth(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get(
      { host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs },
      (response) => {
        response.resume();
        done(response.statusCode === 200);
      },
    );
    request.on('timeout', () => {
      request.destroy();
      done(false);
    });
    request.on('error', () => done(false));
  });
}

/**
 * A console counts as running only when its pid is alive *and* `/healthz`
 * answers. A pidfile whose process is gone is stale: it is removed so the next
 * `hugin start` can launch a fresh server.
 */
export async function inspectConsole({
  root = DEFAULT_ROOT,
  port = DEFAULT_CONSOLE_PORT,
  deps = {},
}: { root?: string; port?: number; deps?: ConsoleDeps } = {}): Promise<ConsoleStatus> {
  const fallbackUrl = `http://127.0.0.1:${port}`;
  const existed = fs.existsSync(consolePidPath(root));
  const info = readConsolePid(root);
  if (!info) {
    if (existed) removeConsolePid(root);
    return { running: false, pid: null, port, url: fallbackUrl, stale: existed };
  }
  const alive = (deps.isAlive ?? isProcessAlive)(info.pid);
  if (!alive) {
    removeConsolePid(root);
    return { running: false, pid: info.pid, port: info.port, url: info.url, stale: true };
  }
  const healthy = await (deps.health ?? checkConsoleHealth)(info.port);
  return { running: healthy, pid: info.pid, port: info.port, url: info.url, stale: false };
}

function spawnConsoleServer(root: string, port: number): number | null {
  const entry = path.join(root, 'bin', 'hugin-console.mjs');
  if (!fs.existsSync(entry)) return null;
  const logFile = path.join(root, '.hugin', 'logs', 'console.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [entry, '--port', String(port)], {
      cwd: root,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, HUGIN_ROOT: root },
      windowsHide: true,
    });
  } finally {
    fs.closeSync(out);
  }
  child.unref();
  return child.pid ?? null;
}

/**
 * Start the console detached when it is not already healthy. Spawning is
 * injectable so tests can exercise the pidfile rules without binding a port.
 */
export async function ensureConsole({
  root = DEFAULT_ROOT,
  port = DEFAULT_CONSOLE_PORT,
  deps = {},
}: { root?: string; port?: number; deps?: EnsureConsoleDeps } = {}): Promise<EnsureConsoleResult> {
  const current = await inspectConsole({ root, port, deps });
  if (current.running) return { ...current, started: false };

  const spawnFn = deps.spawn ?? ((spawnPort: number) => spawnConsoleServer(root, spawnPort));
  const pid = spawnFn(port);
  if (!pid) {
    return {
      ...current,
      started: false,
      error: `console launcher is missing at ${path.join(root, 'bin', 'hugin-console.mjs')}`,
    };
  }

  const info: ConsolePidInfo = {
    pid,
    port,
    url: `http://127.0.0.1:${port}`,
    startedAt: new Date().toISOString(),
  };
  writeConsolePid(root, info);
  return { running: true, pid, port, url: info.url, stale: false, started: true };
}

/**
 * Stop the console only when the pidfile still describes a live, healthy
 * server. A pid can be recycled by an unrelated process, so liveness alone is
 * not enough: the recorded port must answer `/healthz` before any signal is
 * sent. In every other case only the pidfile is removed.
 */
export async function stopConsole({
  root = DEFAULT_ROOT,
  port = DEFAULT_CONSOLE_PORT,
  deps = {},
}: { root?: string; port?: number; deps?: ConsoleDeps } = {}): Promise<{
  stopped: boolean;
  pid: number | null;
}> {
  const status = await inspectConsole({ root, port, deps });
  if (status.pid === null) return { stopped: false, pid: null };
  const pid = status.pid;
  if (status.running) {
    try {
      (deps.kill ?? ((target: number) => process.kill(target, 'SIGTERM')))(pid);
    } catch {
      // The process may have exited between the check and the signal.
    }
  }
  removeConsolePid(root);
  return { stopped: status.running, pid };
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
  // The Vite build lands in `web/dist`; fall back to `web/` so the console still
  // serves something before the first `npm run build`.
  const builtRoot = path.join(root, 'web', 'dist');
  const webRoot = fs.existsSync(path.join(builtRoot, 'index.html'))
    ? builtRoot
    : path.join(root, 'web');
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
  // Containment on the lexical path is not enough: a symlink under webRoot can
  // still resolve outside it. Compare real paths before reading anything.
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = fs.realpathSync(webRoot);
    realTarget = fs.realpathSync(target);
  } catch {
    sendText(res, 404, 'not found');
    return;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
    sendText(res, 403, 'forbidden');
    return;
  }
  let body: Buffer;
  try {
    body = fs.readFileSync(realTarget);
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
      // antd 5 injects runtime <style> tags (CSS-in-JS), so styles need 'unsafe-inline'.
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  };
  res.writeHead(200, headers);
  res.end(method === 'HEAD' ? undefined : body);
}

/**
 * Only loopback names are valid. Anything else is a DNS-rebinding attempt: a
 * foreign page resolves its own hostname to 127.0.0.1, and the Host header is
 * the only thing that tells the two apart. A missing port means the request
 * reached the bound port, which is the same listener.
 */
function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (typeof hostHeader !== 'string') return false;
  const value = hostHeader.trim().toLowerCase();
  return ['127.0.0.1', 'localhost'].some(
    (name) => value === name || value === `${name}:${port}`,
  );
}

export function createConsoleServer({
  root = DEFAULT_ROOT,
  host = '127.0.0.1',
  port = 8787,
}: { root?: string; host?: string; port?: number } = {}): http.Server {
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const bound = server.address();
    const listeningPort = bound && typeof bound === 'object' ? bound.port : port;
    if (!hostAllowed(req.headers.host, listeningPort)) {
      sendText(res, 403, 'forbidden');
      return;
    }
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
  return server;
}
