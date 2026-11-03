import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildState, listRuns, createConsoleServer } from '../lib/console.js';
function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugin-console-'));
    const runDir = path.join(root, '.hugin', 'runs', 'testrun');
    fs.mkdirSync(path.join(runDir, 'tasks', 'T1'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(root, '.hugin', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(root, '.hugin', 'CURRENT_RUN'), 'testrun\n');
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run: 'testrun', base: 'abc1234', status: 'active' }));
    fs.writeFileSync(path.join(runDir, 'board.json'), JSON.stringify({
        run: 'testrun',
        tasks: [
            {
                id: 'T1',
                title: 'Fix multiply and add divide',
                owner: 'impl-1',
                status: 'complete',
                files: ['examples/fixture/calc.py'],
                deps: [],
            },
        ],
    }));
    fs.writeFileSync(path.join(runDir, 'brief.md'), 'Fix multiply and implement divide.');
    fs.writeFileSync(path.join(runDir, 'tasks', 'T1', 'handoff.json'), JSON.stringify({
        status: 'complete',
        branch: 'hugin/T1',
        files_changed: ['examples/fixture/calc.py'],
        commands_run: [{ cmd: 'python3 -m unittest', exit: 0 }],
        ac: [{ criterion: 'multiply(3, 4) == 12', proof: 'ok' }],
        residual_risks: ['none'],
        memory_candidates: [{ text: 'fixture is red by design', why: 'seed' }],
    }));
    fs.writeFileSync(path.join(runDir, 'reviews', 'T1-correctness.json'), JSON.stringify({
        lens: 'correctness',
        findings: [
            {
                id: 'C1',
                severity: 'high',
                file: 'examples/fixture/calc.py',
                line: 3,
                claim: 'wrong operator',
                evidence: 'test_multiply fails',
                suggestion: 'use *',
            },
        ],
    }));
    fs.writeFileSync(path.join(runDir, 'reviews', 'T1-verdict.json'), JSON.stringify({
        verdict: 'BLOCK',
        checks: [{ cmd: 'python3 -m unittest', exit: 0, output: 'OK' }],
        blockers: ['high finding open'],
    }));
    fs.writeFileSync(path.join(root, '.hugin', 'memory', 'INDEX.md'), '# Index\n- one\n');
    fs.writeFileSync(path.join(root, '.hugin', 'memory', 'lessons.md'), '- 2026-11-03: lesson\n');
    return root;
}
test('listRuns reads run metadata', () => {
    const root = makeFixture();
    const runs = listRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, 'testrun');
    assert.equal(runs[0].base, 'abc1234');
});
test('buildState hydrates tasks, evidence, reviews, and memory', () => {
    const root = makeFixture();
    const state = buildState({ root });
    assert.equal(state.run.id, 'testrun');
    assert.equal(state.tasks.length, 1);
    const task = state.tasks[0];
    assert.equal(task.id, 'T1');
    assert.equal(task.handoff.status, 'complete');
    assert.equal(task.reviews[0].lens, 'correctness');
    assert.equal(task.openFindings, 1);
    assert.equal(task.verdict.verdict, 'BLOCK');
    assert.equal(task.stage.key, 'review');
    assert.equal(task.stage.action, 'inspect open findings');
    assert.match(state.memory.index, /# Index/);
    assert.match(state.brief, /multiply/);
});
test('buildState marks a blocked worker as attention', () => {
    const root = makeFixture();
    const state = buildState({
        root,
        workers: [
            {
                id: 'w1',
                name: 'hugin-testrun-T1-impl',
                state: 'blocked',
                waitingFor: 'permission to edit',
            },
        ],
    });
    const task = state.tasks[0];
    assert.equal(task.worker.state, 'blocked');
    assert.equal(task.stage.key, 'attention');
    assert.match(task.stage.action, /hugin attach w1/);
    assert.ok(state.attention.some((item) => item.kind === 'attention'));
});
test('buildState surfaces workersError as a system attention item', () => {
    const root = makeFixture();
    const state = buildState({ root, workersError: 'claude not found on PATH' });
    assert.ok(state.attention.some((item) => item.kind === 'system'));
});
test('HTTP API serves state and blocks path traversal', async () => {
    const root = makeFixture();
    const server = createConsoleServer({ root });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    try {
        const health = (await fetch(`${base}/healthz`).then((response) => response.json()));
        assert.equal(health.ok, true);
        const runs = (await fetch(`${base}/api/runs`).then((response) => response.json()));
        assert.equal(runs.runs[0].id, 'testrun');
        const stateResponse = await fetch(`${base}/api/state?run=testrun`);
        assert.equal(stateResponse.status, 200);
        const state = (await stateResponse.json());
        assert.equal(state.run.id, 'testrun');
        assert.equal(state.tasks[0].id, 'T1');
        assert.equal(stateResponse.headers.get('cache-control'), 'no-store');
        const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
        assert.ok([403, 404].includes(traversal.status));
    }
    finally {
        await new Promise((resolve) => server.close(() => resolve()));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
