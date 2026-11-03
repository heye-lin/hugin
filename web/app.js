const REFRESH_MS = 15000;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

const clear = (node) => {
  node.replaceChildren();
};

const state = {
  runs: [],
  data: null,
  selectedRun: null,
  selectedTaskId: null,
  loading: false,
  timer: null,
};

function text(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text(value);
  return date
    .toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: '2-digit' })
    .toUpperCase();
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text(value);
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function statusNode(stage) {
  const node = el('span', 'status', stage?.label ?? 'Unknown');
  node.dataset.state = stage?.key ?? 'unknown';
  return node;
}

function notice(message, tone = 'info') {
  const node = document.getElementById('notice');
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.dataset.tone = tone;
  node.textContent = message;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function loadRuns() {
  try {
    const payload = await fetchJson('/api/runs');
    state.runs = Array.isArray(payload.runs) ? payload.runs : [];
    renderRunSelect();
  } catch (error) {
    notice(`Cannot load runs: ${error.message}`, 'error');
  }
}

async function load(runId) {
  if (state.loading) return;
  state.loading = true;
  const button = document.getElementById('refresh');
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = 'Loading';

  try {
    const query = runId ? `?run=${encodeURIComponent(runId)}` : '';
    const payload = await fetchJson(`/api/state${query}`);
    state.data = payload;
    state.selectedRun = payload.run?.id ?? null;
    if (
      state.selectedTaskId &&
      !payload.tasks.some((task) => task.id === state.selectedTaskId)
    ) {
      state.selectedTaskId = null;
    }
    notice(payload.workersError ? `claude agents: ${payload.workersError}` : '');
    render();
  } catch (error) {
    notice(`Cannot load state: ${error.message}`, 'error');
  } finally {
    state.loading = false;
    button.disabled = false;
    button.textContent = previous;
  }
}

function renderRunSelect() {
  const select = document.getElementById('run-select');
  clear(select);
  if (state.runs.length === 0) {
    const option = el('option', null, 'no runs');
    option.value = '';
    select.append(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const run of state.runs) {
    const option = el('option', null, run.id);
    option.value = run.id;
    if (run.id === state.selectedRun) option.selected = true;
    select.append(option);
  }
}

function render() {
  const data = state.data;
  if (!data) return;

  const run = data.run;
  const base = run?.base ?? '—';
  document.getElementById('meta-date').textContent = formatDate(data.generatedAt);
  document.getElementById('meta-run').textContent = `run ${text(run?.id)}`;
  document.getElementById('issue-run').textContent = text(run?.id);
  document.getElementById('issue-base').textContent = text(base).slice(0, 12);
  document.getElementById('generated-at').textContent = formatTime(data.generatedAt);

  renderBrief(data);
  renderStats(data);
  renderAttention(data);
  renderTasks(data);
  renderDetail(data);
  renderGate(data);
  renderWorkers(data);
  renderMemory(data);
  renderRunSelect();
}

function renderBrief(data) {
  const panel = document.getElementById('brief-panel');
  const textNode = document.getElementById('brief-text');
  if (!data.brief) {
    panel.hidden = true;
    textNode.textContent = '';
    return;
  }
  panel.hidden = false;
  textNode.textContent = data.brief;
}

function renderStats(data) {
  const tasks = data.tasks ?? [];
  const complete = tasks.filter((task) => task.stage?.key === 'complete').length;
  const blocked = tasks.filter((task) =>
    ['blocked', 'attention', 'failed'].includes(task.stage?.key),
  ).length;
  const findings = tasks.reduce((total, task) => total + (task.openFindings ?? 0), 0);
  document.getElementById('stat-tasks').textContent = tasks.length;
  document.getElementById('stat-done').textContent = complete;
  document.getElementById('stat-blocked').textContent = blocked;
  document.getElementById('stat-findings').textContent = findings;
  document.getElementById('stat-attention').textContent = (data.attention ?? []).length;
}

function renderAttention(data) {
  const list = document.getElementById('attention-list');
  const items = data.attention ?? [];
  document.getElementById('attention-count').textContent = String(items.length);
  clear(list);
  if (items.length === 0) {
    list.append(el('li', 'empty', 'Nothing needs a person.'));
    return;
  }
  items.forEach((item, index) => {
    const row = el('li', 'attention-item');
    row.dataset.kind = item.kind ?? 'info';
    row.append(el('span', 'attention-index', String(index + 1).padStart(2, '0')));

    const body = el('div');
    body.append(el('p', 'attention-title', item.title));
    if (item.detail) body.append(el('p', 'attention-detail', item.detail));
    row.append(body);
    row.append(el('span', 'attention-action', item.action ?? ''));
    list.append(row);
  });
}

function renderTasks(data) {
  const tbody = document.getElementById('task-rows');
  const tasks = data.tasks ?? [];
  document.getElementById('ledger-count').textContent =
    tasks.length === 0 ? 'no tasks' : `${tasks.length} item${tasks.length === 1 ? '' : 's'}`;
  clear(tbody);

  if (tasks.length === 0) {
    const row = el('tr');
    const cell = el('td', 'empty', 'No tasks recorded for this run.');
    cell.colSpan = 5;
    row.append(cell);
    tbody.append(row);
    return;
  }

  for (const task of tasks) {
    const row = el('tr');
    row.tabIndex = 0;
    row.setAttribute('aria-selected', task.id === state.selectedTaskId ? 'true' : 'false');
    row.addEventListener('click', () => selectTask(task.id));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectTask(task.id);
      }
    });

    row.append(el('td', 'task-id', task.id));
    row.append(el('td', 'task-title', task.title));
    row.append(el('td', 'task-owner', text(task.owner, '—')));
    const statusCell = el('td');
    statusCell.append(statusNode(task.stage));
    row.append(statusCell);
    row.append(el('td', 'task-evidence', task.evidenceLabel ?? '—'));
    tbody.append(row);
  }
}

function selectTask(taskId) {
  state.selectedTaskId = taskId === state.selectedTaskId ? null : taskId;
  renderTasks(state.data);
  renderDetail(state.data);
  const detail = document.getElementById('task-detail');
  if (!detail.hidden) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function detailBlock(title, children) {
  const block = el('div', 'detail-block');
  block.append(el('h4', null, title));
  for (const child of children) {
    if (child) block.append(child);
  }
  return block;
}

function listNode(items, className = '') {
  const list = el('ul', className);
  for (const item of items) list.append(el('li', null, item));
  return list;
}

function tagList(items) {
  const list = el('ul', 'tag-list');
  for (const item of items) list.append(el('li', null, item));
  return list;
}

function preNode(value) {
  return el('pre', 'prose-pre', value);
}

function renderDetail(data) {
  const detail = document.getElementById('task-detail');
  const task = (data.tasks ?? []).find((item) => item.id === state.selectedTaskId);
  clear(detail);
  if (!task) {
    detail.hidden = true;
    return;
  }
  detail.hidden = false;

  const head = el('div', 'detail-head');
  head.append(el('h3', null, `${task.id} · ${task.title}`));
  const meta = el('div', 'detail-meta');
  meta.append(el('span', null, `Owner ${text(task.owner)}`));
  meta.append(statusNode(task.stage));
  if (task.worker) meta.append(el('span', null, `Session ${task.worker.state}`));
  head.append(meta);
  detail.append(head);

  if (task.stage?.action) {
    detail.append(preNode(`Action: ${task.stage.action}`));
  }

  const grid = el('div', 'detail-grid');

  const scopeChildren = [];
  if (task.files.length > 0) {
    scopeChildren.push(tagList(task.files));
  } else {
    scopeChildren.push(el('p', 'empty', 'No files declared.'));
  }
  if (task.deps.length > 0) {
    scopeChildren.push(el('p', null, `Depends on: ${task.deps.join(', ')}`));
  }
  grid.append(detailBlock('Scope', scopeChildren));

  const handoff = task.handoff;
  if (!handoff) {
    grid.append(detailBlock('Evidence', [el('p', 'empty', 'No handoff written yet.')]));
  } else {
    const handoffChildren = [
      el(
        'p',
        null,
        `Status ${text(handoff.status)} · Branch ${text(handoff.branch)}`,
      ),
    ];
    if (handoff.filesChanged.length > 0) {
      handoffChildren.push(tagList(handoff.filesChanged));
    }
    if (handoff.commandsRun.length > 0) {
      const lines = handoff.commandsRun
        .map(
          (command) =>
            `$ ${command.cmd}\nexit ${text(command.exit)}${command.log ? ` · ${command.log}` : ''}`,
        )
        .join('\n\n');
      handoffChildren.push(preNode(lines));
    }
    grid.append(detailBlock('Handoff', handoffChildren));
  }

  if (handoff && handoff.ac.length > 0) {
    const acList = el('ul');
    for (const item of handoff.ac) {
      const li = el('li');
      li.append(el('strong', null, item.criterion));
      if (item.proof) li.append(el('span', null, ` — ${item.proof}`));
      acList.append(li);
    }
    grid.append(detailBlock('Acceptance', [acList]));
  }

  if (task.verdict) {
    const verdictChildren = [
      el('p', null, `Verdict ${text(task.verdict.verdict)}`),
    ];
    if (task.verdict.checks.length > 0) {
      verdictChildren.push(
        preNode(
          task.verdict.checks
            .map((check) => `$ ${check.cmd}\nexit ${text(check.exit)}\n${check.output}`)
            .join('\n\n'),
        ),
      );
    }
    if (task.verdict.blockers.length > 0) {
      verdictChildren.push(listNode(task.verdict.blockers));
    }
    grid.append(detailBlock('Verification', verdictChildren));
  }

  detail.append(grid);

  const reviewsSection = el('div', 'detail-block');
  reviewsSection.append(el('h4', null, 'Review findings'));
  if (task.reviews.length === 0) {
    reviewsSection.append(el('p', 'empty', 'No reviewer output recorded.'));
  } else {
    for (const review of task.reviews) {
      const heading = el('p', null, `${review.lens} · ${review.count} finding(s)`);
      reviewsSection.append(heading);
      if (review.findings.length === 0) {
        reviewsSection.append(el('p', 'empty', 'No findings.'));
        continue;
      }
      const findings = el('div', 'findings');
      for (const finding of review.findings) {
        const item = el('article', 'finding');
        const headRow = el('div', 'finding-head');
        headRow.append(el('span', 'finding-id', text(finding.id, '—')));
        const severity = el('span', 'severity', text(finding.severity, 'unknown'));
        severity.dataset.severity = String(finding.severity ?? '').toLowerCase();
        headRow.append(severity);
        if (finding.file) {
          headRow.append(el('span', 'finding-id', `${finding.file}:${text(finding.line, '?')}`));
        }
        item.append(headRow);
        item.append(el('p', null, finding.claim));
        if (finding.evidence) item.append(el('p', 'evidence', finding.evidence));
        if (finding.suggestion) item.append(el('p', null, `Suggestion: ${finding.suggestion}`));
        findings.append(item);
      }
      reviewsSection.append(findings);
    }
  }
  detail.append(reviewsSection);

  const riskItems = [
    ...(handoff?.residualRisks ?? []),
    ...(handoff?.unverified ?? []),
    ...(task.verdict?.unverified ?? []),
  ];
  if (riskItems.length > 0) {
    detail.append(detailBlock('Residual risks', [listNode(riskItems)]));
  }

  const memoryItems = (handoff?.memoryCandidates ?? []).filter((item) => item.text);
  if (memoryItems.length > 0) {
    detail.append(
      detailBlock(
        'Memory candidates',
        [
          listNode(
            memoryItems.map((item) =>
              item.why ? `${item.text} — ${item.why}` : item.text,
            ),
          ),
        ],
      ),
    );
  }
}

function renderGate(data) {
  const body = document.getElementById('gate-body');
  const verdictNode = document.getElementById('gate-verdict');
  clear(body);

  const gate = data.gate;
  const board = data.reviewBoard;
  const verdict = gate?.verdict ?? board?.verdict ?? null;
  verdictNode.textContent = verdict ?? '—';
  verdictNode.dataset.state = verdict === 'PASS' ? 'complete' : verdict ? 'failed' : '';

  if (!gate && !board) {
    body.append(el('p', 'empty', 'No gate record.'));
    return;
  }

  if (gate) {
    const line = el('div', 'gate-line');
    line.append(el('span', 'gate-verdict', text(gate.verdict)));
    if (gate.testPassed !== null) {
      line.append(el('span', 'label', `Tests ${gate.testPassed ? 'passed' : 'failed'}`));
    }
    body.append(line);
    if (gate.reasons.length > 0) body.append(listNode(gate.reasons));
    if (gate.residualRisks.length > 0) {
      body.append(el('h4', 'subhead', 'Residual risks'));
      body.append(listNode(gate.residualRisks));
    }
  }

  if (board) {
    body.append(el('h4', 'subhead', 'Review board'));
    body.append(el('p', null, `${text(board.verdict)} — ${text(board.summary, 'no summary')}`));
    if (board.blockers.length > 0) body.append(listNode(board.blockers));
  }
}

function renderWorkers(data) {
  const list = document.getElementById('worker-list');
  clear(list);
  if (data.workersError) {
    list.append(el('li', 'empty', data.workersError));
    return;
  }
  const workers = data.workers ?? [];
  if (workers.length === 0) {
    list.append(el('li', 'empty', 'No Hugin sessions running.'));
    return;
  }
  for (const worker of workers) {
    const item = el('li', 'session');
    item.append(el('p', 'session-name', worker.name || worker.id));
    const meta = el('div', 'session-meta');
    const status = el('span', 'status', worker.state);
    status.dataset.state = worker.state;
    meta.append(status);
    if (worker.startedAt) meta.append(el('span', null, formatTime(worker.startedAt)));
    if (worker.id) meta.append(el('span', null, worker.id));
    item.append(meta);
    if (worker.waitingFor) {
      item.append(el('p', 'session-wait', worker.waitingFor));
    }
    list.append(item);
  }
}

function renderMemory(data) {
  const index = document.getElementById('memory-index');
  const lessons = document.getElementById('memory-lessons');
  index.textContent = text(data.memory?.index, 'No memory index.');
  lessons.textContent = text(data.memory?.lessons, 'No lessons recorded.');
}

function schedule() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (!document.hidden) load(state.selectedRun);
  }, REFRESH_MS);
}

function bind() {
  document.getElementById('refresh').addEventListener('click', () =>
    load(state.selectedRun),
  );
  document.getElementById('run-select').addEventListener('change', (event) => {
    state.selectedTaskId = null;
    load(event.target.value || undefined);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load(state.selectedRun);
  });
}

async function init() {
  bind();
  await loadRuns();
  await load();
  schedule();
}

document.addEventListener('DOMContentLoaded', init);
