---
name: hugin-run
description: Run a Hugin supervised multi-Claude session. Use when the user asks to run Hugin, start a supervised team, or execute a multi-step feature with review, test, and security gates.
---

# Hugin Run

You are the Master. Follow these steps in order. Do not skip the gates and do not claim completion without evidence.

## 0. Preflight

```bash
./bin/hugin doctor --quick
```

Decide the run id:

- If the invocation names a run (`/hugin-run <run-id>`), use it. Create it only when `.hugin/runs/<run-id>` is missing: `./bin/hugin new-run <run-id>`.
- Otherwise, if `.hugin/CURRENT_RUN` points to an existing run that has no `final-report.md`, reuse it and say which run you are continuing.
- Otherwise create a fresh run: `./bin/hugin new-run`.

Record the run id as `<run>`. If doctor fails, stop and report the failing check.

Then write `.hugin/runs/<run>/brief.md` with the goal, scope, constraints, exact verification command, and a short excerpt from `.hugin/memory/INDEX.md` / `lessons.md` that applies. Workers get this through the `SessionStart` hook, but the dispatch prompt must still carry the essentials.

## 1. Understand and decompose

Restate the requirement in one paragraph. If it is ambiguous, ask the user one focused question.

Before decomposing, read `.hugin/memory/INDEX.md`, `decisions.md`, and the relevant `lessons.md` entries. Reuse prior decisions instead of re-litigating them; note any memory that is stale.

- Small requirement: decompose yourself.
- Large requirement: dispatch the planner as a background session:

```bash
claude --bg --name "hugin-<run>-plan" \
  --agent hugin-planner \
  --permission-mode acceptEdits \
  --settings .claude/hugin/worker-settings.json \
  "Read the repository and decompose this requirement into tasks. Requirement: <text>. Return the task table."
```

Then `claude agents --json --all`, wait for `state: done`, and read its output with `claude logs <id>`.

## 2. Create the board and tasks

Write `.hugin/runs/<run>/board.json`:

```json
{
  "run": "<run>",
  "base": "<base commit>",
  "status": "active",
  "tasks": [
    { "id": "T1", "title": "...", "owner": "impl-1", "files": ["..."], "deps": [], "status": "pending", "worker": null }
  ]
}
```

Create each task with the native task tools, using this description template:

```
Goal: <one line>
AC:
- <observable criterion>
Files: <allowed files>
Evidence: .hugin/runs/<run>/tasks/T1/handoff.json
Owner: impl-1
Deps: none
```

The `TaskCreated` hook blocks tasks without `AC:` or `Evidence:`.

## 3. Dispatch implementers

One implementer at a time. Include the full context because background sessions do not inherit your conversation:

```bash
claude --bg --name "hugin-<run>-T1-impl" \
  --agent hugin-implementer \
  --permission-mode acceptEdits \
  --settings .claude/hugin/worker-settings.json \
  "Run <run>, task T1. Repo: /mnt/d/code/Hugin. Base commit: <sha>.
Brief: .hugin/runs/<run>/brief.md
Relevant memory: <1-3 lines from INDEX/lessons>
Allowed files: <files>.
AC:
<ac>
Verify with:
- <exact command>
Write the handoff to .hugin/runs/<run>/tasks/T1/handoff.json using docs/task-format.md.
Include memory_candidates for reusable, non-obvious facts.
Do not modify other files. Do not push. Commit on your worktree branch and report it."
```

Update `board.json` with the returned short id (the `claude --bg` output prints it) and `state: working`.

## 4. Supervise

Poll:

```bash
claude agents --json --all
```

Or open the read-only console for the same data plus evidence and memory:

```bash
./bin/hugin console
```

Filter by `name` prefix `hugin-<run>-`. For each worker:

| State | Action |
|---|---|
| `working` | Wait. Check again after a reasonable interval. |
| `blocked` | Tell the user to run `./bin/hugin attach <id>`; never guess or auto-approve. |
| `done` | Read the handoff; verify `status: complete`, commands, and AC proofs. |
| `failed` / `stopped` | `claude logs <id>`; re-dispatch at most 3 times, then escalate to the user. |

If a worker is `blocked` for more than one check, surface the exact `waitingFor` value to the user.

## 5. Review, test, security

After the implementer is `done`, dispatch three reviewers in parallel, one per lens:

```bash
claude --bg --name "hugin-<run>-T1-review-correctness" \
  --agent hugin-reviewer \
  --permission-mode acceptEdits \
  --settings .claude/hugin/worker-settings.json \
  "Run <run>, task T1, lens=correctness. Base <sha>, head <branch>.
Read the task AC and handoff at <handoff>.
Inspect git diff <sha>...<branch> in /mnt/d/code/Hugin.
Write findings JSON to .hugin/runs/<run>/reviews/T1-correctness.json.
Read-only: do not edit."
```

Repeat with `lens=security` and `lens=tests`, and the matching output paths. For a deterministic strict gate, also run the saved workflow `/review-board` from the Master and persist its result to `.hugin/runs/<run>/reviews/review-board.json`.

## 6. Verify

Dispatch a verifier:

```bash
claude --bg --name "hugin-<run>-T1-verify" \
  --agent hugin-verifier \
  --permission-mode acceptEdits \
  --settings .claude/hugin/worker-settings.json \
  "Run <run>, task T1. Worktree: <path>, branch: <branch>.
Read handoff <path> and all reviewer JSON under .hugin/runs/<run>/reviews/.
Re-run: <exact commands>.
Write verdict JSON to .hugin/runs/<run>/tasks/T1/verdict.json.
Do not edit source."
```

Pass only when:
- every required command exits 0;
- no `blocker` / high severity finding is open;
- verifier verdict is `PASS`;
- every AC has a proof.

For a final strict gate, run `/pre-merge-gate` and persist `gate.json`.

## 7. Fix loop

On `BLOCK`, create a new task that cites the finding ids and evidence paths. Re-dispatch one implementer. Maximum 3 rounds; after that, stop and ask the user.

## 8. Final report

Write `.hugin/runs/<run>/final-report.md` with:

- requirement and scope;
- tasks and owners;
- exact commands run and their outputs;
- reviewer findings that were fixed and that remain;
- verifier verdict;
- residual risks and unverified items;
- branch/worktree list and merge recommendation.

Then promote memory:

1. Collect `memory_candidates` from handoffs, plus recurring findings and non-obvious fixes.
2. Append reusable lessons to `.hugin/memory/lessons.md`, durable choices to `decisions.md`.
3. Update `.hugin/memory/INDEX.md` pointers; delete stale entries. Keep it under 200 lines.
4. Never promote secrets, personal data, transient logs, or unverified guesses.

Stop workers with `claude stop <id>` and update `board.json` to `status: done` or `blocked`. Never merge to main automatically; ask the user.

## Hard rules

- Never sign off your own or a worker's unverified output.
- Reviewers and verifiers are read-only.
- One implementer at a time on the same files.
- No `--dangerously-skip-permissions`.
- No nested teams; spawn another background session instead.
- If a permission prompt appears twice for the same task, stop and ask the user.
