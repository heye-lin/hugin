export const meta = {
  name: 'review-board',
  description: 'Parallel correctness/security/test review with adversarial verification and a board verdict',
  phases: [
    { title: 'Review', detail: 'three independent lenses' },
    { title: 'Verify', detail: 'three skeptics per finding' },
    { title: 'Synthesize', detail: 'deduplicate and decide PASS/BLOCK' },
  ],
}

const RUN = args?.runId ?? 'adhoc'
const BASE = args?.base ?? 'HEAD~1'
const HEAD = args?.head ?? 'HEAD'

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          file: { type: 'string' },
          line: { type: 'number' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['id', 'severity', 'claim', 'evidence'],
      },
    },
    checked: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } },
  },
  required: ['lens', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['refuted', 'reason'],
}

const BOARD_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'BLOCK'] },
    summary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          suggestion: { type: 'string' },
          lens: { type: 'string' },
        },
        required: ['id', 'severity', 'claim'],
      },
    },
  },
  required: ['verdict', 'summary'],
}

const LENSES = ['correctness', 'security', 'tests']

phase('Review')
const boards = await parallel(
  LENSES.map((lens) => () =>
    agent(
      `Review the diff ${BASE}...${HEAD} in this repository through the ${lens} lens only.
Read the task acceptance criteria and handoff under .hugin/runs/${RUN}/ when they exist.
Cite file:line for every finding. Report only defects, not style preferences.
Mark anything you could not verify as unverified. Do not edit any file.`,
      {
        agentType: 'hugin-reviewer',
        label: `review:${lens}`,
        phase: 'Review',
        schema: FINDINGS_SCHEMA,
      },
    ),
  ),
)

const findings = boards
  .filter(Boolean)
  .flatMap((board) => (board.findings ?? []).map((finding) => ({ ...finding, lens: board.lens ?? 'unknown' })))

if (findings.length === 0) {
  return {
    runId: RUN,
    verdict: 'PASS',
    summary: 'No findings from any lens.',
    blockers: [],
    findings: [],
  }
}

phase('Verify')
const judged = await parallel(
  findings.map((finding) => () =>
    parallel(
      [0, 1, 2].map((attempt) => () =>
        agent(
          `Try to refute this code review finding. Finding: ${JSON.stringify(finding)}.
Inspect the actual code and diff ${BASE}...${HEAD}. If the claim is wrong, unreachable, already handled, or not a defect, refuted=true.
If you are uncertain, default to refuted=true. Give a concrete reason.`,
          {
            agentType: 'hugin-verifier',
            label: `refute:${finding.id}:${attempt}`,
            phase: 'Verify',
            schema: VERDICT_SCHEMA,
          },
        ),
      ),
    ).then((votes) => ({
      ...finding,
      refutedVotes: votes.filter(Boolean).filter((vote) => vote.refuted).length,
      refuted: votes.filter(Boolean).filter((vote) => vote.refuted).length >= 2,
    })),
  ),
)

const surviving = judged.filter(Boolean).filter((finding) => !finding.refuted)

phase('Synthesize')
const board = await agent(
  `You are the review board. Produce one verdict for the diff ${BASE}...${HEAD}.
Findings that survived adversarial verification:
${JSON.stringify(surviving)}
Rules:
- BLOCK if any surviving critical finding exists.
- BLOCK if a surviving high finding has no clear mitigation captured in the findings.
- Otherwise PASS, and list residual risks in the summary.
Deduplicate by file/line/claim. Do not invent findings.`,
  {
    agentType: 'hugin-reviewer',
    label: 'board:synthesize',
    phase: 'Synthesize',
    schema: BOARD_SCHEMA,
  },
)

return {
  runId: RUN,
  base: BASE,
  head: HEAD,
  verdict: board?.verdict ?? 'BLOCK',
  summary: board?.summary ?? 'Synthesis failed; treat as BLOCK.',
  blockers: board?.blockers ?? [],
  findings: board?.findings ?? surviving,
  dropped: judged.filter(Boolean).filter((finding) => finding.refuted).map((finding) => finding.id),
}
