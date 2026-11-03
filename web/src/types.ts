/**
 * 与 src/lib/console.ts 的 ConsoleState 保持一致的前端形状。
 * 只声明控制台用得到的字段，避免把后端内部结构整体搬进前端。
 */

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

export interface WorkerInfo {
  id?: string;
  name?: string;
  state?: string;
  waitingFor?: string;
  cwd?: string;
  startedAt?: string;
}

export interface Handoff {
  status: string;
  branch: string;
  worktree: string;
  filesChanged: string[];
  commandsRun: { cmd: string; exit: number | null; log: string }[];
  ac: { criterion: string; proof: string }[];
  residualRisks: string[];
  unverified: string[];
  memoryCandidates: { text: string; why: string; scope: string }[];
}

export interface Task {
  id: string;
  title: string;
  owner: string;
  status: string;
  boardStatus: string;
  stage: Stage;
  worker: WorkerInfo | null;
  evidenceLabel: string;
  deps: string[];
  files: string[];
  handoff: Handoff | null;
  reviews: unknown[];
  verdict: unknown;
  openFindings: number;
}

export interface ConsoleState {
  generatedAt: string;
  repo: string;
  runs: RunInfo[];
  run: RunInfo | null;
  brief: string;
  runNotes: string;
  finalReport: string;
  tasks: Task[];
  summary: SummaryCounts;
  queue: QueueItem[];
  attention: unknown[];
  gate: unknown;
  reviewBoard: unknown;
  reviewFiles: string[];
  memory: { index: string; lessons: string; decisions: string };
  /** /api/state 额外附带的 `claude agents` 快照。 */
  workers?: WorkerInfo[];
  workersError?: string | null;
}
