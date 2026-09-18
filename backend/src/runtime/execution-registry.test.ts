import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executionRegistry, RunCancelledError } from './execution-registry';

const uid = () => `run-${Math.random().toString(36).slice(2, 10)}`;

describe('cancellation (audit finding E1)', () => {
  it('signals an abort to the running execution', () => {
    const runId = uid();
    const signal = executionRegistry.begin(runId, 'project-1');
    assert.equal(signal.aborted, false);

    assert.equal(executionRegistry.cancel(runId, 'operator stopped it'), true);
    assert.equal(signal.aborted, true);
    executionRegistry.end(runId);
  });

  it('reports false when the run is not executing in this process', () => {
    // The caller still records the intent durably; this only says "no local worker".
    assert.equal(executionRegistry.cancel(uid(), 'not here'), false);
  });

  it('throwIfCancelled turns a cancelled run into a typed error at the next checkpoint', () => {
    const runId = uid();
    executionRegistry.begin(runId, 'project-1');

    assert.doesNotThrow(() => executionRegistry.throwIfCancelled(runId));
    executionRegistry.cancel(runId, 'deadline exceeded');

    assert.throws(() => executionRegistry.throwIfCancelled(runId), RunCancelledError);
    try {
      executionRegistry.throwIfCancelled(runId);
    } catch (err) {
      // The reason survives to the operator rather than becoming a generic stop.
      assert.match((err as Error).message, /deadline exceeded/);
    }
    executionRegistry.end(runId);
  });

  it('ignores an undefined run id, so ad-hoc calls need no special casing', () => {
    assert.doesNotThrow(() => executionRegistry.throwIfCancelled(undefined));
  });

  it('refuses to begin the same run twice', () => {
    const runId = uid();
    executionRegistry.begin(runId, 'project-1');
    assert.throws(() => executionRegistry.begin(runId, 'project-1'), /already executing/);
    executionRegistry.end(runId);
  });

  it('cancelAll stops every in-flight run, for shutdown', () => {
    const a = uid();
    const b = uid();
    const signalA = executionRegistry.begin(a, 'p1');
    const signalB = executionRegistry.begin(b, 'p2');

    const stopped = executionRegistry.cancelAll('shutting down');
    assert.ok(stopped.includes(a) && stopped.includes(b));
    assert.equal(signalA.aborted, true);
    assert.equal(signalB.aborted, true);

    executionRegistry.end(a);
    executionRegistry.end(b);
  });
});

describe('project checkout lock (audit finding E5)', () => {
  it('serializes concurrent access to one project', async () => {
    const order: string[] = [];
    const project = `project-${Math.random()}`;

    const slow = executionRegistry.withProjectLock(project, async () => {
      order.push('a:start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('a:end');
    });
    const fast = executionRegistry.withProjectLock(project, async () => {
      order.push('b:start');
      order.push('b:end');
    });

    await Promise.all([slow, fast]);

    // Without the lock this interleaves as a:start, b:start, b:end, a:end —
    // which is exactly two agents editing one working tree at once.
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('runs different projects in parallel', async () => {
    const running = { count: 0, peak: 0 };
    const hold = async () => {
      running.count += 1;
      running.peak = Math.max(running.peak, running.count);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running.count -= 1;
    };

    await Promise.all([
      executionRegistry.withProjectLock(`p-${Math.random()}`, hold),
      executionRegistry.withProjectLock(`p-${Math.random()}`, hold),
    ]);

    assert.equal(running.peak, 2, 'separate projects must not block each other');
  });

  it('releases the lock when the holder throws', async () => {
    const project = `project-${Math.random()}`;

    await assert.rejects(
      executionRegistry.withProjectLock(project, async () => {
        throw new Error('step exploded');
      }),
      /step exploded/,
    );

    // A leaked lock would hang this forever, which is why it is asserted.
    const after = await executionRegistry.withProjectLock(project, async () => 'recovered');
    assert.equal(after, 'recovered');
  });

  it('does not let one failed holder poison the queue behind it', async () => {
    const project = `project-${Math.random()}`;
    const failing = executionRegistry
      .withProjectLock(project, async () => {
        throw new Error('first failed');
      })
      .catch(() => 'handled');
    const following = executionRegistry.withProjectLock(project, async () => 'second ran');

    assert.equal(await failing, 'handled');
    assert.equal(await following, 'second ran');
  });
});
