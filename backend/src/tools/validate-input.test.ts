import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateToolInput } from './validate-input';
import { writeFileTool } from './file-editor.tool';
import { runCommandTool } from './terminal.tool';

/**
 * Audit finding S7: tool schemas were sent to the model and then trusted.
 * TypeScript interfaces vanish at runtime, so `write_file` could receive
 * `{ path: 42 }` and pass a number to the permission guard and to `fs`.
 */
describe('validateToolInput', () => {
  it('accepts a well-formed call', () => {
    const result = validateToolInput(writeFileTool.inputSchema, {
      path: 'src/server.ts',
      content: 'export const x = 1;',
      reason: 'add a constant',
    });
    assert.equal(result.ok, true);
  });

  it('rejects a missing required argument', () => {
    const result = validateToolInput(writeFileTool.inputSchema, { path: 'a.ts', content: 'x' });
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.includes("'reason' is required")));
  });

  it('rejects a wrong scalar type instead of passing it through', () => {
    const result = validateToolInput(writeFileTool.inputSchema, {
      path: 42,
      content: 'x',
      reason: 'y',
    });
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.includes('must be a string')));
  });

  it('rejects unknown properties when additionalProperties is false', () => {
    const result = validateToolInput(writeFileTool.inputSchema, {
      path: 'a.ts',
      content: 'x',
      reason: 'y',
      mode: '0777',
    });
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.includes("'mode' is not a recognised argument")));
  });

  it('validates array item types', () => {
    const ok = validateToolInput(runCommandTool.inputSchema, {
      command: 'npm',
      args: ['run', 'test'],
      reason: 'run the suite',
    });
    assert.equal(ok.ok, true);

    const bad = validateToolInput(runCommandTool.inputSchema, {
      command: 'npm',
      args: ['run', 7],
      reason: 'run the suite',
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.ok === false && bad.errors.some((e) => e.includes('args[1]')));
  });

  it('rejects a non-object payload', () => {
    assert.equal(validateToolInput(writeFileTool.inputSchema, 'oops').ok, false);
    assert.equal(validateToolInput(writeFileTool.inputSchema, null).ok, false);
    assert.equal(validateToolInput(writeFileTool.inputSchema, ['a']).ok, false);
  });

  it('treats an absent optional argument as valid', () => {
    const result = validateToolInput(runCommandTool.inputSchema, {
      command: 'npm',
      reason: 'check the version',
    });
    assert.equal(result.ok, true);
  });

  it('bounds string length so one call cannot carry a megabyte', () => {
    const result = validateToolInput(writeFileTool.inputSchema, {
      path: 'a.ts',
      content: 'x'.repeat(500_000),
      reason: 'huge',
    });
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.errors.some((e) => e.includes('over the')));
  });
});
