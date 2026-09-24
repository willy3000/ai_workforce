import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { SettingsService, type PlatformSettings, type SettingsStore } from './settings.service';

const defaults: PlatformSettings = {
  accessMode: 'full_access',
  repairAttempts: 3,
  publishRunBranches: true,
};

function fixture() {
  let stored: PlatformSettings | null = null;
  let writes = 0;
  const store: SettingsStore = {
    async read() { return stored; },
    async write(patch, initial) {
      writes += 1;
      stored = { ...(stored ?? initial), ...patch };
      return stored;
    },
  };
  return {
    store,
    service: new SettingsService(store, defaults),
    writes: () => writes,
  };
}

describe('installation settings', () => {
  it('uses full access before settings are first saved', async () => {
    const { service, writes } = fixture();
    assert.deepEqual(await service.get(), defaults);
    assert.equal(writes(), 0);
  });

  it('preserves independent settings across partial saves and service restarts', async () => {
    const { service, store } = fixture();
    await service.update({ accessMode: 'requires_approval' });
    await service.update({ repairAttempts: 0, publishRunBranches: false });
    const restarted = new SettingsService(store, { ...defaults, repairAttempts: 9 });
    assert.deepEqual(await restarted.get(), {
      accessMode: 'requires_approval', repairAttempts: 0, publishRunBranches: false,
    });
  });

  it('reads policy changes from another worker immediately', async () => {
    const { service, store } = fixture();
    const secondWorker = new SettingsService(store, defaults);
    await service.update({ accessMode: 'requires_approval' });
    assert.equal((await secondWorker.get()).accessMode, 'requires_approval');
    await service.update({ accessMode: 'full_access' });
    assert.equal((await secondWorker.get()).accessMode, 'full_access');
  });

  it('rejects unknown fields, malformed values and empty updates without writing', async () => {
    const { service, writes } = fixture();
    for (const input of [
      {}, { accessMode: 'admin' }, { repairAttempts: -1 }, { repairAttempts: 11 },
      { repairAttempts: 1.5 }, { repairAttempts: '3' }, { publishRunBranches: 'false' },
      { accessMode: 'full_access', surprise: true }, null,
    ]) {
      await assert.rejects(service.update(input), ZodError);
    }
    assert.equal(writes(), 0);
  });

  it('propagates database failures instead of treating them as full access', async () => {
    const { store } = fixture();
    store.read = async () => { throw new Error('Database unavailable'); };
    const service = new SettingsService(store, defaults);
    await assert.rejects(service.get(), /Database unavailable/);
  });
});
