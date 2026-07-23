'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { Button, Card, ErrorNote, Field, TextArea, TextInput } from '@/components/ui';

/**
 * Repository onboarding.
 *
 * Offers both paths deliberately: a GitHub URL (needs a token) and a local
 * directory (needs nothing). The local path is not a fallback — it is the
 * correct choice for evaluating the platform against a private codebase you
 * would rather not hand a token for.
 */
export function ConnectProject({ onConnected }: { onConnected?: () => void }) {
  const [mode, setMode] = useState<'github' | 'local'>('github');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [branch, setBranch] = useState('');
  const [name, setName] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');

  const connect = useAction(api.connectProject);

  const submit = async () => {
    const body =
      mode === 'github'
        ? { repositoryUrl: repositoryUrl.trim(), branch: branch.trim() || undefined }
        : { localPath: localPath.trim(), name: name.trim() || undefined };

    const res = await connect.execute({
      ...body,
      customInstructions: customInstructions.trim() || undefined,
    });
    if (res?.project) {
      setRepositoryUrl('');
      setLocalPath('');
      setCustomInstructions('');
      onConnected?.();
    }
  };

  const valid = mode === 'github' ? repositoryUrl.trim().length > 3 : localPath.trim().length > 0;

  return (
    <Card>
      <div className="mb-3 flex gap-1">
        {(['github', 'local'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
              mode === m
                ? 'border-[var(--series-1)] text-[var(--series-1)]'
                : 'text-[var(--text-muted)]'
            }`}
          >
            {m === 'github' ? 'GitHub repository' : 'Local directory'}
          </button>
        ))}
      </div>

      {mode === 'github' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Field label="Repository URL" hint="https://github.com/owner/repo or owner/repo">
              <TextInput
                placeholder="https://github.com/acme/storefront"
                value={repositoryUrl}
                onChange={(e) => setRepositoryUrl(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Branch" hint="Defaults to the repo default">
            <TextInput placeholder="main" value={branch} onChange={(e) => setBranch(e.target.value)} />
          </Field>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Field label="Absolute path" hint="No GitHub token needed — everything except PR creation works">
              <TextInput
                placeholder="C:\\Users\\you\\code\\my-app"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Project name" hint="Optional">
            <TextInput placeholder="my-app" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
      )}

      <div className="mt-3">
        <Field
          label="Standing orders for this codebase (optional)"
          hint="Injected into every agent's system prompt for this project — house rules the agents must always follow."
        >
          <TextArea
            rows={2}
            placeholder="This is a regulated fintech codebase. Never use floating point for currency. Any change touching money needs a test asserting exact decimal amounts."
            value={customInstructions}
            onChange={(e) => setCustomInstructions(e.target.value)}
          />
        </Field>
      </div>

      {connect.error && (
        <div className="mt-3">
          <ErrorNote message={connect.error} />
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] text-[var(--text-muted)]">
          {connect.pending
            ? 'Cloning, indexing and detecting the stack…'
            : 'Clones, indexes every file, detects the stack, and seeds project memory.'}
        </p>
        <Button variant="primary" onClick={submit} disabled={!valid || connect.pending}>
          {connect.pending ? 'Onboarding…' : 'Connect repository'}
        </Button>
      </div>
    </Card>
  );
}
