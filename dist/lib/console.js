import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = process.env.HUGIN_ROOT
    ? path.resolve(process.env.HUGIN_ROOT)
    : path.resolve(HERE, '../..');
export const DEFAULT_CONSOLE_PORT = 8787;
const LENSES = ['correctness', 'security', 'tests'];
function safeName(value) {
    return (typeof value === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
        !value.includes('..'));
}
function cap(value, max = 1200) {
    if (value === null || value === undefined)
        return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}\n…` : text;
}
function readText(file, max = 6000) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        return text.length > max ? `${text.slice(0, max)}\n…` : text;
    }
    catch {
        return '';
    }
}
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
function readCurrentRun(root) {
    return readText(path.join(root, '.hugin', 'CURRENT_RUN'), 200).trim();
}
export function listRuns(root = DEFAULT_ROOT) {
    const dir = path.join(root, '.hugin', 'runs');
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
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
function scanTaskDirs(runDir) {
    if (!runDir)
        return [];
    const dir = path.join(runDir, 'tasks');
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && safeName(entry.name))
            .map((entry) => ({ id: entry.name }));
    }
    catch {
        return [];
    }
}
function severityBucket(value) {
    const severity = String(value ?? '').toLowerCase();
    if (severity === 'blocker')
        return 'critical';
    if (severity === 'major')
        return 'high';
    if (severity === 'minor')
        return 'low';
    return severity;
}
function readReview(runDir, taskId, lens) {
    const data = readJson(path.join(runDir, 'reviews', `${taskId}-${lens}.json`));
    if (!data)
        return null;
    const findings = Array.isArray(data.findings)
        ? data.findings.map((finding) => ({
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
        high: findings.filter((finding) => ['critical', 'high'].includes(severityBucket(finding.severity))).length,
        findings,
        checked: Array.isArray(data.checked) ? data.checked.map((item) => cap(item, 300)) : [],
        unverified: Array.isArray(data.unverified)
            ? data.unverified.map((item) => cap(item, 300))
            : [],
    };
}
function readVerdict(runDir, taskId) {
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
                    ? data.checks.slice(0, 30).map((check) => ({
                        cmd: cap(check?.cmd, 500),
                        exit: Number.isFinite(check?.exit) ? check.exit : null,
                        output: cap(check?.output, 800),
                    }))
                    : [],
                ac: Array.isArray(data.ac)
                    ? data.ac.slice(0, 30).map((item) => ({
                        criterion: cap(item?.criterion, 500),
                        result: cap(item?.result, 40),
                    }))
                    : [],
                blockers: Array.isArray(data.blockers) ? data.blockers.map((item) => cap(item, 500)) : [],
                unverified: Array.isArray(data.unverified)
                    ? data.unverified.map((item) => cap(item, 500))
                    : [],
            };
        }
    }
    return null;
}
function deriveStage(task, handoff, verdict, reviews, worker) {
    const openFindings = reviews.reduce((total, review) => total +
        review.findings.filter((finding) => ['critical', 'high', 'medium'].includes(severityBucket(finding.severity))).length, 0);
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
function hydrateTask(task, runDir, workers) {
    const id = cap(task?.id ?? task?.task ?? '', 80);
    const safe = safeName(id);
    const handoff = safe && runDir ? readJson(path.join(runDir, 'tasks', id, 'handoff.json')) : null;
    const reviews = safe && runDir ? LENSES.map((lens) => readReview(runDir, id, lens)).filter(Boolean) : [];
    const verdict = safe && runDir ? readVerdict(runDir, id) : null;
    const worker = workers.find((candidate) => candidate.id === task?.worker ||
        candidate.name === task?.worker ||
        (id && typeof candidate.name === 'string' && candidate.name.includes(`-${id}-`))) ?? null;
    const commandsRun = Array.isArray(handoff?.commands_run)
        ? handoff.commands_run.slice(0, 30).map((command) => ({
            cmd: cap(command?.cmd, 600),
            exit: Number.isFinite(command?.exit) ? command.exit : null,
            log: cap(command?.log, 300),
        }))
        : [];
    const ac = Array.isArray(handoff?.ac)
        ? handoff.ac.slice(0, 30).map((item) => ({
            criterion: cap(item?.criterion, 500),
            proof: cap(item?.proof, 800),
        }))
        : [];
    const memoryCandidates = Array.isArray(handoff?.memory_candidates)
        ? handoff.memory_candidates.slice(0, 20).map((item) => ({
            text: cap(item?.text ?? item, 600),
            why: cap(item?.why, 400),
            scope: cap(item?.scope, 100),
        }))
        : [];
    const openFindings = reviews.reduce((total, review) => total +
        review.findings.filter((finding) => ['critical', 'high', 'medium'].includes(severityBucket(finding.severity))).length, 0);
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
        deps: Array.isArray(task?.deps) ? task.deps.map((dep) => cap(dep, 80)) : [],
        files: Array.isArray(task?.files) ? task.files.map((file) => cap(file, 300)) : [],
        handoff: handoff
            ? {
                status: cap(handoff.status, 40),
                branch: cap(handoff.branch, 200),
                worktree: cap(handoff.worktree, 400),
                filesChanged: Array.isArray(handoff.files_changed)
                    ? handoff.files_changed.map((file) => cap(file, 300))
                    : [],
                commandsRun,
                ac,
                residualRisks: Array.isArray(handoff.residual_risks)
                    ? handoff.residual_risks.map((item) => cap(item, 500))
                    : [],
                unverified: Array.isArray(handoff.unverified)
                    ? handoff.unverified.map((item) => cap(item, 500))
                    : [],
                memoryCandidates,
            }
            : null,
        reviews,
        verdict,
        openFindings,
    };
}
function taskIsComplete(task) {
    if (String(task?.boardStatus ?? task?.status ?? '') === 'complete')
        return true;
    return task?.handoff?.status === 'complete' && task?.verdict?.verdict === 'PASS';
}
function taskNeedsReview(task) {
    if (String(task?.boardStatus ?? '') === 'review')
        return true;
    return task?.handoff?.status === 'complete' && task?.verdict?.verdict !== 'PASS';
}
/**
 * Roll a run up into the five counts the terminal and the web console share.
 * Worker counts are scoped to this run's session names (`hugin-<run>-…`);
 * `queued` is board order, filtered to pending tasks whose deps are all complete.
 */
export function summarizeTasks(tasks, workers = [], runId = null) {
    const prefix = runId ? `hugin-${runId}-` : 'hugin-';
    const scoped = workers.filter((worker) => typeof worker?.name === 'string' && worker.name.startsWith(prefix));
    const workerState = (worker) => String(worker?.state ?? worker?.status ?? '');
    const counts = {
        running: scoped.filter((worker) => workerState(worker) === 'working').length,
        queued: 0,
        review: 0,
        blocked: scoped.filter((worker) => workerState(worker) === 'blocked').length,
        complete: 0,
    };
    const byId = new Map();
    for (const task of tasks)
        byId.set(String(task?.id ?? ''), task);
    const queue = [];
    for (const task of tasks) {
        if (taskIsComplete(task)) {
            counts.complete += 1;
            continue;
        }
        if (taskNeedsReview(task)) {
            counts.review += 1;
            continue;
        }
        if (String(task?.boardStatus ?? '') !== 'pending')
            continue;
        const deps = Array.isArray(task?.deps) ? task.deps.map((dep) => String(dep)) : [];
        const ready = deps.every((dep) => {
            const target = byId.get(dep);
            return Boolean(target) && taskIsComplete(target);
        });
        if (!ready)
            continue;
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
function normalizeGate(runDir) {
    const data = readJson(path.join(runDir, 'reviews', 'gate.json'));
    if (!data)
        return null;
    const gate = data.gate ?? data;
    return {
        verdict: cap(gate.verdict, 30) || 'BLOCK',
        reasons: Array.isArray(gate.reasons) ? gate.reasons.map((item) => cap(item, 800)) : [],
        residualRisks: Array.isArray(gate.residual_risks)
            ? gate.residual_risks.map((item) => cap(item, 800))
            : [],
        testPassed: typeof data.test?.passed === 'boolean' ? data.test.passed : null,
    };
}
function normalizeReviewBoard(runDir) {
    const data = readJson(path.join(runDir, 'reviews', 'review-board.json'));
    if (!data)
        return null;
    return {
        verdict: cap(data.verdict, 30) || 'BLOCK',
        summary: cap(data.summary, 1200),
        blockers: Array.isArray(data.blockers) ? data.blockers.map((item) => cap(item, 500)) : [],
    };
}
function collectAttention(tasks, gate, workers, workersError) {
    const items = [];
    for (const task of tasks) {
        if (['attention', 'failed', 'blocked'].includes(task.stage.key)) {
            items.push({
                kind: task.stage.key,
                title: `${task.id} · ${task.title}`,
                detail: task.stage.label,
                action: task.stage.action,
            });
        }
        else if (task.openFindings > 0) {
            items.push({
                kind: 'findings',
                title: `${task.id} · ${task.openFindings} open finding(s)`,
                detail: 'review',
                action: 'inspect the findings',
            });
        }
    }
    for (const worker of workers) {
        if (!['blocked', 'failed'].includes(worker.state))
            continue;
        const owned = tasks.some((task) => task.worker?.id === worker.id);
        if (owned)
            continue;
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
export function buildState({ root = DEFAULT_ROOT, runId, workers = [], workersError = null, } = {}) {
    const runs = listRuns(root);
    const stored = readCurrentRun(root);
    const requested = runId && safeName(runId) ? runId : '';
    const effective = (requested && runs.some((run) => run.id === requested) ? requested : '') ||
        (safeName(stored) && runs.some((run) => run.id === stored) ? stored : '') ||
        runs[0]?.id ||
        null;
    const runDir = effective ? path.join(root, '.hugin', 'runs', effective) : '';
    const meta = runDir ? readJson(path.join(runDir, 'run.json')) : null;
    const board = runDir ? readJson(path.join(runDir, 'board.json')) : null;
    const boardTasks = Array.isArray(board?.tasks) ? board.tasks : [];
    const tasks = (boardTasks.length > 0 ? boardTasks : scanTaskDirs(runDir)).map((task) => hydrateTask(task, runDir, workers));
    const memoryDir = path.join(root, '.hugin', 'memory');
    let reviewFiles = [];
    if (runDir) {
        try {
            reviewFiles = fs.readdirSync(path.join(runDir, 'reviews')).map((name) => cap(name, 200));
        }
        catch {
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
export async function readWorkers() {
    try {
        const { stdout } = await execFileAsync('claude', ['agents', '--json', '--all'], {
            timeout: 5000,
            maxBuffer: 4 * 1024 * 1024,
        });
        const all = JSON.parse(stdout);
        const workers = (Array.isArray(all) ? all : [])
            .filter((worker) => typeof worker?.name === 'string' && worker.name.startsWith('hugin-'))
            .map((worker) => ({
            id: cap(worker.id, 100),
            name: cap(worker.name, 200),
            state: cap(worker.state ?? worker.status ?? 'unknown', 40),
            waitingFor: cap(worker.waitingFor, 300),
            cwd: cap(worker.cwd, 400),
            startedAt: cap(worker.startedAt, 60),
        }));
        return { workers, error: null };
    }
    catch (error) {
        const failure = error;
        const message = failure?.code === 'ENOENT'
            ? 'claude not found on PATH'
            : cap(failure?.message ?? String(error), 500);
        return { workers: [], error: message };
    }
}
export function consolePidPath(root = DEFAULT_ROOT) {
    return path.join(root, '.hugin', 'console.pid');
}
function readConsolePid(root = DEFAULT_ROOT) {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(consolePidPath(root), 'utf8'));
    }
    catch {
        return null;
    }
    const pid = Number(data?.pid);
    const port = Number(data?.port);
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        return null;
    return {
        pid,
        port,
        url: typeof data?.url === 'string' && data.url ? data.url : `http://127.0.0.1:${port}`,
        startedAt: typeof data?.startedAt === 'string' ? data.startedAt : '',
    };
}
export function writeConsolePid(root, info) {
    const file = consolePidPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`);
}
export function removeConsolePid(root = DEFAULT_ROOT) {
    try {
        fs.rmSync(consolePidPath(root));
    }
    catch {
        // Already gone.
    }
}
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error?.code === 'EPERM';
    }
}
export async function checkConsoleHealth(port, timeoutMs = 800) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (value) => {
            if (settled)
                return;
            settled = true;
            resolve(value);
        };
        const request = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (response) => {
            response.resume();
            done(response.statusCode === 200);
        });
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
export async function inspectConsole({ root = DEFAULT_ROOT, port = DEFAULT_CONSOLE_PORT, deps = {}, } = {}) {
    const fallbackUrl = `http://127.0.0.1:${port}`;
    const existed = fs.existsSync(consolePidPath(root));
    const info = readConsolePid(root);
    if (!info) {
        if (existed)
            removeConsolePid(root);
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
function spawnConsoleServer(root, port) {
    const entry = path.join(root, 'bin', 'hugin-console.mjs');
    if (!fs.existsSync(entry))
        return null;
    const logFile = path.join(root, '.hugin', 'logs', 'console.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'a');
    let child;
    try {
        child = spawn(process.execPath, [entry, '--port', String(port)], {
            cwd: root,
            detached: true,
            stdio: ['ignore', out, out],
            env: { ...process.env, HUGIN_ROOT: root },
            windowsHide: true,
        });
    }
    finally {
        fs.closeSync(out);
    }
    child.unref();
    return child.pid ?? null;
}
/**
 * Start the console detached when it is not already healthy. Spawning is
 * injectable so tests can exercise the pidfile rules without binding a port.
 */
export async function ensureConsole({ root = DEFAULT_ROOT, port = DEFAULT_CONSOLE_PORT, deps = {}, } = {}) {
    const current = await inspectConsole({ root, port, deps });
    if (current.running)
        return { ...current, started: false };
    const spawnFn = deps.spawn ?? ((spawnPort) => spawnConsoleServer(root, spawnPort));
    const pid = spawnFn(port);
    if (!pid) {
        return {
            ...current,
            started: false,
            error: `console launcher is missing at ${path.join(root, 'bin', 'hugin-console.mjs')}`,
        };
    }
    const info = {
        pid,
        port,
        url: `http://127.0.0.1:${port}`,
        startedAt: new Date().toISOString(),
    };
    writeConsolePid(root, info);
    return { running: true, pid, port, url: info.url, stale: false, started: true };
}
export function stopConsole({ root = DEFAULT_ROOT, deps = {}, } = {}) {
    const info = readConsolePid(root);
    if (!info)
        return { stopped: false, pid: null };
    const alive = (deps.isAlive ?? isProcessAlive)(info.pid);
    if (alive) {
        try {
            (deps.terminate ?? ((pid) => process.kill(pid, 'SIGTERM')))(info.pid);
        }
        catch {
            // The process may have exited between the check and the signal.
        }
    }
    removeConsolePid(root);
    return { stopped: alive, pid: info.pid };
}
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
}
function sendText(res, status, text) {
    res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
}
function serveStatic(root, pathname, res, method) {
    const webRoot = path.join(root, 'web');
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    }
    catch {
        sendText(res, 400, 'bad request');
        return;
    }
    const relative = decoded === '/' ? '/index.html' : decoded;
    const target = path.normalize(path.join(webRoot, relative));
    if (target !== webRoot && !target.startsWith(`${webRoot}${path.sep}`)) {
        sendText(res, 403, 'forbidden');
        return;
    }
    let body;
    try {
        body = fs.readFileSync(target);
    }
    catch {
        sendText(res, 404, 'not found');
        return;
    }
    const headers = {
        'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    };
    res.writeHead(200, headers);
    res.end(method === 'HEAD' ? undefined : body);
}
export function createConsoleServer({ root = DEFAULT_ROOT, host = '127.0.0.1', port = 8787, } = {}) {
    return http.createServer(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
        }
        let url;
        try {
            url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        }
        catch {
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
