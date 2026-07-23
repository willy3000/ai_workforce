import type { WorkflowDefinition } from './types';

/**
 * Code review: two passes with different lenses.
 *
 * QA reviews for correctness and risk; the Engineering Manager reviews for
 * architectural fit. These genuinely find different problems — "this will throw
 * on an empty array" and "this bypasses the repository layer we standardised on"
 * are not the same review — and a single reviewer reliably under-serves one of
 * them.
 */
export const codeReviewWorkflow: WorkflowDefinition = {
  key: 'code-review',
  name: 'Code review',
  description:
    'Review pending or recent changes for correctness, risk, and architectural consistency, ' +
    'then produce a consolidated verdict.',
  trigger: 'A request to review changes on the current branch or a described change set.',
  steps: [
    {
      id: 'correctness',
      name: 'Correctness & risk review',
      agentKey: 'qa-engineer',
      taskType: 'review',
      prompt: `Perform a correctness and risk review.

Review scope: "{{request}}"

Start with git_status(include_diff=true) to see what actually changed, then read the changed files in full — a diff hides the context that makes a change wrong.

Look for: unhandled error paths; missing validation on anything reaching a database or external service; auth and permission gaps; race conditions and unawaited promises; resource leaks; N+1 queries and unbounded loops over user input; secrets in code or logs; breaking changes to existing callers.

Report every finding with file:line, the concrete scenario in which it fails, and a severity. Include low-confidence findings — coverage matters more than precision at this stage. If the code is genuinely fine, say so.`,
      acceptanceCriteria: [
        'The actual diff was read, not just the description',
        'Findings include file:line, a concrete failure scenario, and severity',
        'A clear approve / changes-requested verdict is given',
      ],
    },
    {
      id: 'architecture',
      name: 'Architectural consistency review',
      agentKey: 'engineering-manager',
      taskType: 'review',
      prompt: `Review the same change set for architectural fit.

Review scope: "{{request}}"

Correctness review findings (do not repeat them):
{{steps.correctness}}

Assess: does this follow the patterns already established in this codebase? Does it contradict any accepted architecture decision? Does it introduce a second way of doing something that already has one way? Are the module boundaries respected? Is any new abstraction actually earned by the requirement?

Be specific about what should change and why. If the change is architecturally sound, say so — do not manufacture concerns.`,
      dependsOn: ['correctness'],
      acceptanceCriteria: [
        'Consistency with existing patterns and accepted decisions is assessed',
        'Any architectural concern names the specific pattern being violated',
      ],
    },
    {
      id: 'summary',
      name: 'Consolidated review summary',
      agentKey: 'documentation-engineer',
      taskType: 'documentation',
      dependsOn: ['correctness', 'architecture'],
      optional: true,
      prompt: `Consolidate these two reviews into one report a human can act on.

Correctness & risk review:
{{steps.correctness}}

Architectural review:
{{steps.architecture}}

Produce: an overall verdict, blocking issues (must fix before merge), non-blocking suggestions, and anything the reviewers disagreed about. Deduplicate overlapping findings. Do not soften severities and do not add findings of your own.`,
      acceptanceCriteria: [
        'Blocking and non-blocking issues are separated',
        'Overlapping findings are deduplicated without losing severity',
      ],
    },
  ],
};
