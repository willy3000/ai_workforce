import type { WorkflowDefinition } from './types';

/**
 * Feature development:
 *
 *   Request → Project Manager → Engineering Manager → Backend / Frontend → QA → Docs
 *
 * The two things that make this work in practice:
 *   1. The Engineering Manager step sits between planning and implementation, so
 *      integration contracts exist *before* two engineers write code against
 *      each other.
 *   2. The frontend and backend steps are conditionally skipped based on the
 *      technical plan, so a pure API change does not produce an idle UI agent
 *      inventing a component nobody asked for.
 */
export const featureDevelopmentWorkflow: WorkflowDefinition = {
  key: 'feature-development',
  name: 'Feature development',
  description:
    'End-to-end delivery of a new feature: requirements breakdown, technical design, ' +
    'implementation, verification, and documentation.',
  trigger: 'A request to add new functionality (e.g. "Add a payment feature").',
  steps: [
    {
      id: 'plan',
      name: 'Requirements & work breakdown',
      agentKey: 'project-manager',
      taskType: 'planning',
      prompt: `A stakeholder has requested the following:

"""
{{request}}
"""

Analyse this against the actual repository and produce a work breakdown.
Explicitly state: the scope you are committing to, what is out of scope, whether backend work is needed, whether frontend work is needed, and the acceptance criteria for each piece.
Create the tasks with create_task.`,
      acceptanceCriteria: [
        'Scope and out-of-scope are stated explicitly',
        'Each piece of work has one owning agent and checkable acceptance criteria',
        'The plan references files/modules that actually exist in this repository',
      ],
    },
    {
      id: 'design',
      name: 'Technical plan & architecture decisions',
      agentKey: 'engineering-manager',
      taskType: 'architecture',
      dependsOn: ['plan'],
      prompt: `The Project Manager produced this plan for the request "{{request}}":

{{steps.plan}}

Review it for technical soundness and produce the technical plan the engineers will implement against.
Required output:
1. The design, expressed in terms of THIS codebase's existing modules and patterns.
2. Exact integration contracts for anything split across agents (endpoint paths, request/response shapes, error semantics, module boundaries).
3. Data model / migration impact.
4. Risks, especially around auth, money, and user data.
5. A clear statement of which parts are BACKEND work and which are FRONTEND work. If one of them is not needed at all, say "No backend work required" or "No frontend work required" verbatim.
Record binding choices with record_decision.`,
      acceptanceCriteria: [
        'Design fits the existing codebase patterns',
        'Integration contracts are specified precisely enough for parallel implementation',
        'Architecture decisions are recorded',
        'Backend/frontend split is stated explicitly',
      ],
    },
    {
      id: 'backend',
      name: 'Backend implementation',
      agentKey: 'backend-engineer',
      taskType: 'backend',
      dependsOn: ['design'],
      // Skipped when the technical plan says there is no server-side work.
      skipWhen: (ctx) => /no backend work required/i.test(ctx.design ?? ''),
      prompt: `Implement the backend portion of this technical plan:

{{steps.design}}

Original request: "{{request}}"

Implement exactly the backend scope described — no more. Follow the integration contracts precisely; the frontend is being built against them. Verify your work by running the project's tests or type-checker.`,
      acceptanceCriteria: [
        'Backend scope from the technical plan is implemented',
        'Integration contracts are honoured exactly as specified',
        'Change is verified by running tests or the type-checker, with real output reported',
      ],
    },
    {
      id: 'frontend',
      name: 'Frontend implementation',
      agentKey: 'frontend-engineer',
      taskType: 'frontend',
      dependsOn: ['design'],
      skipWhen: (ctx) => /no frontend work required/i.test(ctx.design ?? ''),
      prompt: `Implement the frontend portion of this technical plan:

{{steps.design}}

Original request: "{{request}}"

Backend implementation report (the API you are integrating against):
{{steps.backend}}

Match the existing UI patterns of this application. Handle loading, empty, error and unauthorized states. Verify with a type-check or build.`,
      acceptanceCriteria: [
        'Frontend scope from the technical plan is implemented',
        'UI matches existing component and styling patterns',
        'Loading, error and empty states are handled',
        'Change is verified by a build or type-check',
      ],
    },
    {
      id: 'qa',
      name: 'Verification & risk review',
      agentKey: 'qa-engineer',
      taskType: 'review',
      dependsOn: ['design'],
      prompt: `Review and verify the work done for the request "{{request}}".

Technical plan (the contract the implementation must satisfy):
{{steps.design}}

Backend report:
{{steps.backend}}

Frontend report:
{{steps.frontend}}

Read the feature diff against the run baseline, including committed changes. Check each acceptance criterion. Repair scoped defects and rerun verification. Inspect package scripts first, install declared dependencies when missing, and use the existing test framework. If none exists, use available build/lint/type checks and a focused behavioral check; document the limitation without blocking a small feature solely for missing infrastructure. Preserve unrelated operator changes. Deliver the verified feature on the run branch.`,
      acceptanceCriteria: [
        'Every acceptance criterion is checked explicitly and its verdict stated',
        'Applicable verification was executed with real output and limitations reported',
        'New behavior is covered by existing test tooling or a documented focused behavioral check',
        'Findings are listed with severity and a concrete failure scenario',
      ],
    },
    {
      id: 'docs',
      name: 'Documentation',
      agentKey: 'documentation-engineer',
      taskType: 'documentation',
      dependsOn: ['qa'],
      optional: true,
      prompt: `Document the feature delivered for the request "{{request}}".

Technical plan:
{{steps.design}}

QA report:
{{steps.qa}}

Update the relevant documentation to reflect what was ACTUALLY built — verify every endpoint, parameter and command against the source before writing it down. Add a changelog entry if the project keeps one.`,
      acceptanceCriteria: [
        'Documentation reflects the code as implemented, verified against source',
        'Any discrepancy found between docs and code is flagged',
      ],
    },
  ],
};
