import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { WorkflowEngine } from './engine';
import { agentRuntime } from '../agents/agent-runtime';
import { taskRepository, workflowRunRepository } from '../database/repositories';
import type { IWorkflowRun, IWorkflowStepState } from '../database/models/workflow-run.model';
import type { AgentOutcome, AgentRunInput, AgentRunResult } from '../agents/types';
import type { WorkflowDefinition } from './types';
import { env } from '../config/env';

function fixture(t: TestContext, outcomes: AgentOutcome[], workflow = 'feature-development') {
  const definition: WorkflowDefinition = { key: workflow, name: 'Test', description: '', trigger: '', steps: [
    { id: 'qa', name: 'Verify', agentKey: 'qa-engineer', taskType: 'testing', prompt: 'Verify {{request}}' },
    { id: 'docs', name: 'Document', agentKey: 'documentation-engineer', taskType: 'documentation', prompt: '{{steps.qa}}', dependsOn: ['qa'] },
  ] };
  const run = { _id: new Types.ObjectId(), projectId: new Types.ObjectId(), request: 'Add reset button',
    workflow, status: 'running', context: {}, steps: definition.steps.map((s) => ({ ...s, status: 'pending', attempt: 0 })),
    changeSet: { branch: 'aiec/reset-button', checks: [] } } as unknown as IWorkflowRun;
  // Preserve ObjectId methods in this in-memory repository.
  t.mock.method(workflowRunRepository, 'findByIdOrFail', async () => run);
  t.mock.method(workflowRunRepository, 'isCancellationRequested', async () => false);
  t.mock.method(workflowRunRepository, 'renewLease', async () => {});
  t.mock.method(workflowRunRepository, 'updateStep', async (_id: unknown, id: string, patch: Partial<IWorkflowStepState>) => {
    Object.assign(run.steps.find((s) => s.id === id)!, patch);
  });
  t.mock.method(workflowRunRepository, 'setContextValue', async (_id: unknown, key: string, value: string) => { run.context[key] = value; });
  t.mock.method(workflowRunRepository, 'setStatusIfNotTerminal', async (_id: unknown, status: IWorkflowRun['status'], patch: Partial<IWorkflowRun>) => {
    Object.assign(run, { status }, patch); return true;
  });
  t.mock.method(workflowRunRepository, 'addUsage', async () => {});
  t.mock.method(taskRepository, 'create', async () => ({ _id: new Types.ObjectId() }));
  t.mock.method(taskRepository, 'transition', async () => {});
  const inputs: AgentRunInput[] = [];
  t.mock.method(agentRuntime, 'run', async (_agent: string, input: AgentRunInput): Promise<AgentRunResult> => {
    inputs.push(input);
    const outcome = outcomes.shift() ?? 'needs_review';
    return { agentKey: _agent, outcome, succeeded: outcome === 'completed', output: outcome === 'completed' ? 'Reset verified' : 'Clear notice state; install missing dependencies',
      iterations: 1, stopReason: 'end_turn', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 } };
  });
  return { run, definition, inputs, engine: new WorkflowEngine() };
}

test('QA needs_review triggers repair with its feedback and continues to docs', async (t) => {
  const f = fixture(t, ['needs_review', 'completed', 'completed']);
  await f.engine['runSteps'](f.run._id, f.definition, new AbortController().signal);
  assert.equal(f.run.status, 'completed');
  assert.equal(f.run.outcome, 'delivered');
  assert.equal(f.run.steps[0].attempt, 2);
  assert.equal(f.run.steps[1].status, 'completed');
  assert.match(f.inputs[1].additionalContext!, /Clear notice state/);
  assert.equal(f.inputs[0].workflowRunId, f.inputs[1].workflowRunId);
});

test('unresolved failures have bounded repair attempts and do not pretend to succeed', async (t) => {
  const f = fixture(t, []);
  await f.engine['runSteps'](f.run._id, f.definition, new AbortController().signal);
  assert.equal(f.inputs.length, 1 + env.WORKFLOW_REPAIR_ATTEMPTS);
  assert.equal(f.run.status, 'failed');
  assert.equal(f.run.steps[1].status, 'pending');
});

test('a repaired check supersedes its earlier failure without deleting history', async (t) => {
  const f = fixture(t, ['completed', 'completed']);
  f.run.changeSet!.checks = [false, true].map((passed) => ({ command: 'web: npm run build', exitCode: passed ? 0 : 1, passed, at: new Date() }));
  await f.engine['runSteps'](f.run._id, f.definition, new AbortController().signal);
  assert.equal(f.run.outcome, 'delivered');
  assert.match(f.run.summary!, /1\/1 check/);
  assert.equal(f.run.changeSet!.checks.length, 2);
});

test('a completed QA claim with an unresolved failed command triggers repair', async (t) => {
  const f = fixture(t, ['completed', 'completed']);
  f.run.changeSet!.checks = [{ command: 'npm test', exitCode: 1, passed: false, at: new Date() }];
  await f.engine['runSteps'](f.run._id, f.definition, new AbortController().signal);
  assert.equal(f.run.status, 'failed');
  assert.match(f.inputs[1].additionalContext!, /Verification still fails: npm test/);
});

test('cancellation stops before a repair pass and review-only workflows do not auto-repair', async (t) => {
  const f = fixture(t, ['needs_review'], 'code-review');
  await f.engine['runSteps'](f.run._id, f.definition, new AbortController().signal);
  assert.equal(f.inputs.length, 1);
  const controller = new AbortController();
  controller.abort();
  await f.engine['runSteps'](f.run._id, f.definition, controller.signal);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.run.status, 'cancelled');
});
