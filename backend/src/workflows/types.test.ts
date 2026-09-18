import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkflowContext, renderTemplate } from './types';

test('normalizeWorkflowContext converts missing context to an empty object', () => {
  assert.deepEqual(normalizeWorkflowContext(null), {});
  assert.deepEqual(normalizeWorkflowContext(undefined), {});
  assert.deepEqual(normalizeWorkflowContext({ plan: 'ready' }), { plan: 'ready' });
});

test('renderTemplate tolerates missing context and preserves handoffs', () => {
  assert.equal(
    renderTemplate('Plan: {{steps.plan}}', 'Build a feature', null),
    "Plan: (no output recorded for step 'plan')",
  );
  assert.equal(
    renderTemplate('Plan: {{steps.plan}}', 'Build a feature', { plan: 'Use the existing API' }),
    'Plan: Use the existing API',
  );
});