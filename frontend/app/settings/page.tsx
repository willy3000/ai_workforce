'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAction, usePoll } from '@/lib/hooks';
import type { WorkforceSettings } from '@/lib/types';
import { Button, ErrorNote, Spinner } from '@/components/ui';

export default function SettingsPage() {
  const settings = usePoll((signal) => api.getSettings(signal), { intervalMs: 0 });

  if (settings.error && !settings.data) {
    return <ErrorNote message={settings.error} onRetry={settings.refresh} />;
  }
  if (!settings.data) return <Spinner label="Loading settings" />;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <p className="eyebrow">Settings</p>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">How your workforce operates</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Set access, automatic repairs, and branch delivery for all projects on this instance.
          Changes take effect when saved, without a restart.
        </p>
      </header>
      <SettingsForm initial={settings.data.settings} />
    </div>
  );
}

function SettingsForm({ initial }: { initial: WorkforceSettings }) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const save = useAction(api.updateSettings);
  const dirty = draft.accessMode !== saved.accessMode
    || draft.repairAttempts !== saved.repairAttempts
    || draft.publishRunBranches !== saved.publishRunBranches;

  const update = <K extends keyof WorkforceSettings>(key: K, value: WorkforceSettings[K]) => {
    save.reset();
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!dirty || save.pending) return;
        const result = await save.execute(draft);
        if (!result) return;
        setSaved(result.settings);
        setDraft(result.settings);
        window.dispatchEvent(new Event('aiec-settings-changed'));
      }}
    >
      <fieldset className="panel p-5" disabled={save.pending} aria-describedby="access-description">
        <legend className="px-1 text-base font-semibold">Access</legend>
        <p id="access-description" className="mb-4 text-sm text-[var(--text-secondary)]">
          Choose whether the workforce needs your approval before continuing its work.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {([
            {
              value: 'full_access',
              title: 'Full access',
              description: 'Allow agents to edit files, run commands, repair problems, and deliver branches without approval pauses.',
            },
            {
              value: 'requires_approval',
              title: 'Requires approval',
              description: 'Pause before each workflow step. Review the planned work and select Approve & continue on the mission page.',
            },
          ] as const).map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-3 rounded-xl border p-4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--series-1)]"
              style={{
                borderColor: draft.accessMode === option.value ? 'var(--series-1)' : 'var(--border)',
                background: draft.accessMode === option.value
                  ? 'color-mix(in srgb, var(--series-1) 6%, var(--surface-1))'
                  : 'var(--surface-1)',
              }}
            >
              <input
                type="radio"
                name="access-mode"
                value={option.value}
                checked={draft.accessMode === option.value}
                onChange={() => update('accessMode', option.value)}
                className="mt-1 accent-[var(--series-1)]"
              />
              <span>
                <span className="block text-sm font-semibold">{option.title}</span>
                <span className="mt-1 block text-xs leading-relaxed text-[var(--text-secondary)]">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
          Full access also continues missions waiting for approval. Failed checks and service errors
          remain visible, with a retry action on the mission.
        </p>
      </fieldset>

      <fieldset className="panel space-y-5 p-5" disabled={save.pending}>
        <legend className="px-1 text-base font-semibold">Execution and delivery</legend>
        <div>
          <label htmlFor="repair-attempts" className="block text-sm font-medium">Automatic repair attempts</label>
          <p id="repair-hint" className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
            How many times an agent can address feedback and retry a step before returning the result
            to you. Choose 0 to disable automatic repairs.
          </p>
          <select
            id="repair-attempts"
            value={draft.repairAttempts}
            aria-describedby="repair-hint"
            onChange={(event) => update('repairAttempts', Number(event.target.value))}
            className="mt-3 rounded-lg border bg-[var(--surface-2)] px-3 py-2 text-sm"
          >
            {Array.from({ length: 11 }, (_, count) => (
              <option key={count} value={count}>{count === 0 ? '0 — disabled' : `${count} ${count === 1 ? 'attempt' : 'attempts'}`}</option>
            ))}
          </select>
        </div>
        <label className="flex cursor-pointer items-start gap-3 border-t pt-5">
          <input
            type="checkbox"
            checked={draft.publishRunBranches}
            onChange={(event) => update('publishRunBranches', event.target.checked)}
            className="mt-1 h-4 w-4 accent-[var(--series-1)]"
          />
          <span>
            <span className="block text-sm font-medium">Deliver branches to connected repositories</span>
            <span className="mt-1 block text-xs leading-relaxed text-[var(--text-secondary)]">
              Publish branches with changes to the original local repositories or configured remote.
              When disabled, branches remain available in the workforce checkout.
            </span>
          </span>
        </label>
      </fieldset>

      {save.error && <ErrorNote message={save.error} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={!dirty || save.pending}>
          {save.pending ? 'Saving…' : 'Save settings'}
        </Button>
        {dirty && (
          <Button disabled={save.pending} onClick={() => { setDraft(saved); save.reset(); }}>
            Discard changes
          </Button>
        )}
        <p role="status" aria-live="polite" className="text-xs text-[var(--text-secondary)]">
          {save.result && !dirty ? 'Settings saved.' : dirty ? 'You have unsaved changes.' : ''}
        </p>
        <Link href="/runs" className="ml-auto text-xs text-[var(--series-1)] underline underline-offset-4">
          View missions
        </Link>
      </div>
    </form>
  );
}
