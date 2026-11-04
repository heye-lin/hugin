import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeBinary } from '../lib/claude.js';
import { readWorkers } from '../lib/console.js';

test('claudeBinary prefers HUGIN_CLAUDE and falls back per platform', () => {
  assert.equal(claudeBinary({ HUGIN_CLAUDE: 'custom-claude' }, 'win32'), 'custom-claude');
  assert.equal(claudeBinary({ HUGIN_CLAUDE: '  /opt/claude  ' }, 'linux'), '/opt/claude');
  assert.equal(claudeBinary({}, 'win32'), 'claude.exe');
  assert.equal(claudeBinary({}, 'linux'), 'claude');
  assert.equal(claudeBinary({ HUGIN_CLAUDE: '   ' }, 'win32'), 'claude.exe');
});

test('readWorkers runs the shared claude executable and parses hugin sessions', async () => {
  const previous = process.env.HUGIN_CLAUDE;
  process.env.HUGIN_CLAUDE = 'hugin-test-claude';
  const seen: string[] = [];
  try {
    const payload = JSON.stringify([
      { id: 'w1', name: 'hugin-r1-T1-impl', state: 'working' },
      { id: 'w2', name: 'unrelated-session', state: 'working' },
    ]);
    const result = await readWorkers({
      exec: async (bin, args) => {
        seen.push(`${bin} ${args.join(' ')}`);
        return { stdout: payload };
      },
    });
    assert.deepEqual(seen, ['hugin-test-claude agents --json --all']);
    assert.deepEqual(
      result.workers.map((worker) => worker.id),
      ['w1'],
      'only hugin-* sessions are surfaced',
    );
    assert.equal(result.error, null);
  } finally {
    if (previous === undefined) delete process.env.HUGIN_CLAUDE;
    else process.env.HUGIN_CLAUDE = previous;
  }
});
