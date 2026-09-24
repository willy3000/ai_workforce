import type { WorkflowDefinition } from './types';

/**
 * Bug fixing:
 *
 *   Bug report → Analysis → Fix → Testing → Resolution
 *
 * The analysis step is owned by QA rather than the implementing engineer, and it
 * is explicitly forbidden from proposing a fix. Separating "what is actually
 * broken" from "what should I change" is what stops the classic agent failure of
 * fixing the first plausible-looking line and declaring victory.
 */
export const bugFixingWorkflow: WorkflowDefinition = {
  key: 'bug-fixing',
  name: 'Bug fixing',
  description:
    'Diagnose a reported defect, implement a targeted fix, verify it with a regression test, ' +
    'and record the root cause in project memory.',
  trigger: 'A bug report or failing behaviour description.',
  steps: [
    {
      id: 'analysis',
      name: 'Root cause analysis',
      agentKey: 'qa-engineer',
      taskType: 'analysis',
      prompt: `A defect has been reported:

"""
{{request}}
"""

Diagnose it. Locate the responsible code by reading it — do not speculate.

Produce:
1. The exact reproduction path through the code (file:line → file:line).
2. The root cause: the specific line or logic that is wrong, and WHY it is wrong.
3. Blast radius: everything else that depends on this code and could be affected by a change.
4. Whether this is primarily backend or frontend. State "FIX AREA: backend" or "FIX AREA: frontend" verbatim.

Do NOT propose or implement a fix — that is the next step's job. If you cannot find a root cause with evidence, say so plainly rather than guessing.`,
      acceptanceCriteria: [
        'Root cause identified with specific file and line references',
        'Reproduction path through the code is traced',
        'Blast radius of a change is assessed',
        'Fix area (backend/frontend) is stated explicitly',
      ],
    },
    {
      id: 'fix',
      name: 'Implement the fix',
      agentKey: 'backend-engineer',
      taskType: 'bugfix',
      dependsOn: ['analysis'],
      skipWhen: (ctx) => /fix area:\s*frontend/i.test(ctx.analysis ?? ''),
      prompt: `Fix the defect described in this root cause analysis:

{{steps.analysis}}

Original report: "{{request}}"

Implement the minimal correct fix for the identified root cause. Do not refactor surrounding code, do not "improve" adjacent logic, and do not fix other things you notice — report those instead. Check the blast radius listed in the analysis and confirm the fix does not break those call sites. Verify by running the tests.`,
      acceptanceCriteria: [
        'The identified root cause is fixed (not a symptom)',
        'The change is minimal and scoped to the defect',
        'Call sites listed in the blast radius still work',
        'Tests were run and their real output reported',
      ],
    },
    {
      id: 'fix-frontend',
      name: 'Implement the fix (frontend)',
      agentKey: 'frontend-engineer',
      taskType: 'bugfix',
      dependsOn: ['analysis'],
      skipWhen: (ctx) => !/fix area:\s*frontend/i.test(ctx.analysis ?? ''),
      prompt: `Fix the frontend defect described in this root cause analysis:

{{steps.analysis}}

Original report: "{{request}}"

Implement the minimal correct fix. Do not restyle or refactor beyond the defect. Verify with a type-check or build.`,
      acceptanceCriteria: [
        'The identified root cause is fixed',
        'The change is minimal and scoped to the defect',
        'Verified by a build or type-check',
      ],
    },
    {
      id: 'regression',
      name: 'Regression test & verification',
      agentKey: 'qa-engineer',
      taskType: 'testing',
      dependsOn: ['analysis'],
      prompt: `Verify the fix for this defect: "{{request}}"

Root cause analysis:
{{steps.analysis}}

Fix report (backend):
{{steps.fix}}

Fix report (frontend):
{{steps.fix-frontend}}

1. Add a regression test using the existing framework. If none exists, use a focused reproducible behavioral check and document the limitation; do not add orphan test files.
2. Inspect available scripts, install declared dependencies when missing, run applicable verification and report real output. Repair scoped failures and rerun the checks.
3. Confirm the blast radius identified in the analysis is unaffected.
4. State plainly whether the defect is resolved.`,
      acceptanceCriteria: [
        'The defect is covered by a regression test or a documented reproducible behavioral check',
        'Applicable verification was run and its real output reported',
        'Blast radius was re-checked',
        'An explicit resolved / not-resolved verdict is given',
      ],
    },
    {
      id: 'record',
      name: 'Record the root cause',
      agentKey: 'documentation-engineer',
      taskType: 'documentation',
      dependsOn: ['regression'],
      optional: true,
      prompt: `Record what was learned from this defect so it does not recur.

Report: "{{request}}"
Root cause: {{steps.analysis}}
Verification: {{steps.regression}}

Use remember(kind="known_issue") to store the root cause pattern and how to avoid it. Update documentation only if the defect revealed that the docs were wrong.`,
      acceptanceCriteria: [
        'Root cause pattern is stored in project memory',
        'Documentation corrected if it was inaccurate',
      ],
    },
  ],
};
