export const meta = {
  name: 'pre-merge-gate',
  description: 'Run tests, compose the review board, and return one PASS/BLOCK merge gate',
  phases: [
    { title: 'Tests', detail: 'independent test run' },
    { title: 'Review', detail: 'review-board' },
    { title: 'Decision', detail: 'single gate verdict' },
  ],
}

const RUN = args?.runId ?? 'adhoc'
const BASE = args?.base ?? 'HEAD~1'
const HEAD = args?.head ?? 'HEAD'
const TEST_COMMAND = args?.testCommand ?? 'python3 -m unittest discover -s examples/fixture -v'

const TEST_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    commands: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cmd: { type: 'string' },
          exit: { type: 'number' },
          output_excerpt: { type: 'string' },
        },
        required: ['cmd', 'exit'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['passed', 'commands'],
}

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'BLOCK'] },
    reasons: { type: 'array', items: { type: 'string' } },
    residual_risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'reasons'],
}

phase('Tests')
const test = await agent(
  `Run this exact test command from the repository root and report the result: ${TEST_COMMAND}
Do not edit files. Capture the exact command and exit code.`,
  {
    agentType: 'hugin-verifier',
    label: 'gate:tests',
    phase: 'Tests',
    schema: TEST_SCHEMA,
  },
)

phase('Review')
let review
try {
  review = await workflow('review-board', { runId: RUN, base: BASE, head: HEAD })
} catch (error) {
  review = {
    runId: RUN,
    verdict: 'BLOCK',
    summary: `review-board failed: ${error?.message ?? String(error)}`,
    blockers: ['review-board could not complete'],
    findings: [],
  }
}

phase('Decision')
const gate = await agent(
  `Decide the merge gate for run ${RUN}, diff ${BASE}...${HEAD}.
Test result:
${JSON.stringify(test)}
Review board:
${JSON.stringify(review)}
Rules:
- BLOCK if tests did not pass.
- BLOCK if the review board verdict is BLOCK.
- BLOCK if either result is missing or INCOMPLETE.
- PASS only when both are PASS.
Return concise reasons and residual risks.`,
  {
    agentType: 'hugin-verifier',
    label: 'gate:decision',
    phase: 'Decision',
    schema: GATE_SCHEMA,
  },
)

return {
  runId: RUN,
  base: BASE,
  head: HEAD,
  gate: gate ?? { verdict: 'BLOCK', reasons: ['decision agent failed'] },
  test,
  review,
}
