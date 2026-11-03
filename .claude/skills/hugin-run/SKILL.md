---
name: hugin-run
description: Run a Hugin supervised multi-Claude session. Use when the user asks to run Hugin, start a supervised team, or execute a multi-step feature with review, test, and security gates.
---

# Hugin Run

You are the Master. Follow these steps in order. Do not skip the gates and do not claim completion without evidence.

## Language

Read `.hugin/config.json` (`language`, default `zh-CN`). If the file is missing or the user asks to change it, ask once — 中文 / English / other — then persist with `./bin/hugin lang <code>`.

Use that language for every user-facing message, `brief.md`, task descriptions, dispatch prompts, and `final-report.md`. Put `Language: <code>` in every worker prompt.

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
  "Read the repository and decompose this requirement into tasks. Requirement: <text>. Language: <code>. Return the task table."
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

**Same platform only.** Master and every worker must run on the same platform: Windows Master → Windows `claude --bg`; WSL Master → WSL `claude --bg`. The two `claude agents` registries are separate and you cannot supervise or stop a session from the other side.

**Isolate first.** Background sessions cannot write the shared checkout or the main repo's `.hugin/runs/`. Create the task's worktree from the Master, then launch the worker inside it:

```bash
./bin/hugin work <run> T1 --base <sha>     # prints the worktree path
cd <worktree-path> && claude --bg --name "hugin-<run>-T1-impl" \
  --agent hugin-implementer \
  --permission-mode acceptEdits \
  --settings .claude/hugin/worker-settings.json \
  "Run <run>, task T1. Language: <code>. Repo: <repo-root>. Worktree: <worktree-path>. Base commit: <sha>.
Brief: <repo-root>/.hugin/runs/<run>/brief.md
Relevant memory: <1-3 lines from INDEX/lessons>
Allowed files: <files>.
AC:
<ac>
Verify with:
- <exact command, using python on Windows and python3 on WSL>
Write the handoff inside your worktree to <worktree-path>/.hugin/runs/<run>/tasks/T1/handoff.json (docs/task-format.md).
Include memory_candidates for reusable, non-obvious facts.
Do not modify other files. Do not push, do not commit. Do not mark the task complete; leave the worktree uncommitted and report it."
```

Prefer plain `git status` / `git diff` / `git log` in worker prompts (cwd is the worktree). The allowlist also covers read-only `git -C <path> <status|diff|log|show|rev-parse|branch>`; `-C` forms of write commands are not allowed, and `git -C ... push` / `reset --hard` are denied.

Update `board.json` with the returned short id (the `claude --bg` output prints it) and `state: working`.

When the worker is `done`:

```bash
./bin/hugin collect <run> T1     # copies the handoff (and referenced logs) into the run
```

Then commit the worker's branch from the Master (a worker started inside a pre-existing worktree is asked before committing, so it must not do this itself):

```bash
git -C <worktree-path> add -A
git -C <worktree-path> commit -m "feat(<task>): <summary>"
```

Then mark the task complete. `TaskCompleted` only sees the main-repo evidence file, so never mark complete before `collect`.

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
  "Run <run>, task T1, lens=correctness. Language: <code>. Repo: <repo-root>. Base <sha>, head <branch>.
Read the task AC and handoff at <handoff>.
Review the branch from <repo-root> with plain `git diff <sha>...<branch>` (reviewers need no worktree).
Return the findings JSON as your final message; Write is disabled for reviewers.
Read-only: do not edit."
```

Reviewers return the JSON in their final message — `Write` is disabled for the role. The Master stages it verbatim to `.hugin/runs/<run>/reviews/T1-correctness.json` and adds `"staged_by": "master"`. Repeat with `lens=security` and `lens=tests`, and the matching output paths. For a deterministic strict gate, also run the saved workflow `/review-board` from the Master and persist its result to `.hugin/runs/<run>/reviews/review-board.json`.

## 6. Verify

Dispatch a verifier:

```bash
claude --bg --name "hugin-<run>-T1-verify" \
  --agent hugin-verifier \
  --permission-mode acceptEdits \
  --settings .claude/hugin/worker-settings.json \
  "Run <run>, task T1. Language: <code>. Repo: <repo-root>. Worktree: <path>, branch: <branch>.
Read handoff <path> and all reviewer JSON under .hugin/runs/<run>/reviews/.
Re-run: <exact commands>.
Return the verdict JSON as your final message; Write is disabled for verifiers.
Do not edit source."
```

The Master stages the verdict to `.hugin/runs/<run>/tasks/T1/verdict.json` with `"staged_by": "master"`.

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

- Use the run language from `.hugin/config.json`; do not switch mid-run.
- Never sign off your own or a worker's unverified output.
- Reviewers and verifiers are read-only.
- One implementer at a time on the same files.
- No `--dangerously-skip-permissions`.
- No nested teams; spawn another background session instead.
- If a permission prompt appears twice for the same task, stop and ask the user.
