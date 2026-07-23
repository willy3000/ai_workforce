'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { Project, WorkflowDefinition } from '@/lib/types';
import { agentColor, agentShort } from '@/lib/design';
import { Button, Card, ErrorNote, Field, Select, TextArea } from '@/components/ui';

const EXAMPLES: Record<string, string> = {
  'feature-development':
    'Add a payment feature: users can pay for a subscription with Stripe, see their payment history, and download invoices.',
  'bug-fixing':
    'Users occasionally get charged twice when they double-click the Pay button.',
  'code-review':
    'Review the changes on the current branch for correctness and architectural consistency.',
};

/**
 * The control that actually commissions work from the AI organization.
 *
 * It shows the step graph for the selected workflow *before* you submit, so you
 * can see which agents will run and where the approval gates are — rather than
 * discovering that after it has started editing a repository.
 */
export function RunLauncher({
  projects,
  workflows,
  defaultProjectId,
  onStarted,
}: {
  projects: Project[];
  workflows: WorkflowDefinition[];
  defaultProjectId?: string;
  onStarted?: () => void;
}) {
  const router = useRouter();
  const readyProjects = projects.filter((p) => p.status === 'ready');

  const [projectId, setProjectId] = useState(defaultProjectId ?? readyProjects[0]?._id ?? '');
  const [workflow, setWorkflow] = useState(workflows[0]?.key ?? 'feature-development');
  const [request, setRequest] = useState('');

  const start = useAction(api.startWorkflow);
  const selected = workflows.find((w) => w.key === workflow);

  const submit = async () => {
    if (!projectId || !request.trim()) return;
    const res = await start.execute({ projectId, workflow, request: request.trim() });
    if (res?.run) {
      onStarted?.();
      router.push(`/runs/${res.run._id}`);
    }
  };

  if (!readyProjects.length) {
    return (
      <Card>
        <p className="text-sm font-medium">No project connected yet</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Connect a repository before commissioning work — the agents read your actual codebase,
          so there is nothing for them to work on until one is onboarded.
        </p>
        <div className="mt-3">
          <Button variant="primary" size="sm" onClick={() => router.push('/projects')}>
            Connect a repository
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Project">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {readyProjects.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Workflow">
          <Select
            value={workflow}
            onChange={(e) => {
              setWorkflow(e.target.value);
              if (!request.trim()) setRequest('');
            }}
          >
            {workflows.map((w) => (
              <option key={w.key} value={w.key}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-3">
        <Field
          label="What do you want built?"
          hint={selected?.trigger}
        >
          <TextArea
            rows={3}
            value={request}
            placeholder={EXAMPLES[workflow] ?? 'Describe the work in plain language…'}
            onChange={(e) => setRequest(e.target.value)}
          />
        </Field>
        {!request.trim() && EXAMPLES[workflow] && (
          <button
            onClick={() => setRequest(EXAMPLES[workflow]!)}
            className="mt-1 text-[11px] text-[var(--series-1)] underline underline-offset-2"
          >
            Use the example request
          </button>
        )}
      </div>

      {/* Preview the plan before committing to it. */}
      {selected && (
        <div className="mt-3 rounded-lg border bg-[var(--surface-2)] p-2.5">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            Agents that will run
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {selected.steps.map((step, i) => (
              <span key={step.id} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden className="text-[var(--text-muted)]">→</span>}
                <span
                  className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]"
                  style={{ borderColor: agentColor(step.agent), color: agentColor(step.agent) }}
                  title={`${step.name}${step.conditional ? ' (conditional)' : ''}`}
                >
                  <span className="font-bold">{agentShort(step.agent)}</span>
                  {step.conditional && <span aria-hidden title="Runs only if needed">◑</span>}
                  {step.requiresApproval && <span aria-hidden title="Requires approval">⏸</span>}
                </span>
              </span>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-[var(--text-muted)]">
            ◑ conditional — skipped automatically if the technical plan says it is not needed ·
            ⏸ pauses for your approval
          </p>
        </div>
      )}

      {start.error && (
        <div className="mt-3">
          <ErrorNote message={start.error} />
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] text-[var(--text-muted)]">
          {start.pending
            ? 'Agents are working — this can take several minutes.'
            : 'Runs execute several agents in sequence against your real repository.'}
        </p>
        <Button
          variant="primary"
          onClick={submit}
          disabled={start.pending || !request.trim() || !projectId}
        >
          {start.pending ? 'Running…' : 'Commission work'}
        </Button>
      </div>
    </Card>
  );
}
