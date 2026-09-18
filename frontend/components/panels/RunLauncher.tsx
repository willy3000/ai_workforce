'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { api } from '@/lib/api';
import { useAction, usePoll } from '@/lib/hooks';
import type { Project, WorkflowDefinition } from '@/lib/types';
import { agentIdentity } from '@/lib/agent-visuals';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { Button, ErrorNote, Field, Select, TextArea } from '@/components/ui';

const EXAMPLES: Record<string, string> = {
  'feature-development':
    'Add a payment feature: users can pay for a subscription with Stripe, see their payment history, and download invoices.',
  'bug-fixing': 'Users occasionally get charged twice when they double-click the Pay button.',
  'code-review':
    'Review the changes on the current branch for correctness and architectural consistency.',
};

/**
 * Commission work from the workforce.
 *
 * ## Three audit findings addressed here
 *
 * **Launch feedback.** Submission used to wait for the entire workflow to
 * finish, so the operator stared at a spinner for minutes and the run id
 * arrived only at the end. The backend now returns a queued run immediately and
 * this navigates straight to it — the run page is where waiting belongs,
 * because that is where progress is visible.
 *
 * **Scope correctness.** The project was copied into state once at mount, so
 * changing the surrounding project selection left the launcher pointing at the
 * old one — and the operator could commission work against a repository they
 * were no longer looking at. The selection is now reconciled when the incoming
 * default changes, and a project that stops being ready is cleared rather than
 * silently kept.
 *
 * **Plan preview.** The step graph, the agents, the approval gates and the
 * write scope are all shown before submission, so "which repository is about to
 * be edited, by whom" is answerable before anything runs rather than after.
 */
export function RunLauncher({
  projects,
  defaultProjectId,
  onLaunched,
}: {
  projects: Project[];
  defaultProjectId?: string;
  onLaunched?: () => void;
}) {
  const router = useRouter();
  const workflows = usePoll((signal) => api.listWorkflows(signal), { intervalMs: 0 });
  const definitions = useMemo(() => workflows.data?.workflows ?? [], [workflows.data]);

  const readyProjects = useMemo(() => projects.filter((p) => p.status === 'ready'), [projects]);

  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [workflow, setWorkflow] = useState('');
  const [request, setRequest] = useState('');
  const [touched, setTouched] = useState(false);

  // Reconcile with the surrounding scope deliberately, rather than capturing it
  // once: an operator who switches project in the header expects this to follow.
  useEffect(() => {
    if (defaultProjectId && readyProjects.some((p) => p._id === defaultProjectId)) {
      setProjectId(defaultProjectId);
      return;
    }
    // Clear a selection that is gone or no longer ready — a stale id would
    // produce a confusing 409 from the backend at submit time.
    setProjectId((current) =>
      readyProjects.some((p) => p._id === current) ? current : (readyProjects[0]?._id ?? ''),
    );
  }, [defaultProjectId, readyProjects]);

  useEffect(() => {
    if (!workflow && definitions.length) setWorkflow(definitions[0]!.key);
  }, [definitions, workflow]);

  const start = useAction(api.startWorkflow);
  const selected = definitions.find((w) => w.key === workflow);
  const project = readyProjects.find((p) => p._id === projectId);

  const requestError =
    touched && request.trim().length > 0 && request.trim().length < 12
      ? 'Describe the work in a sentence — a few words is not enough context for a plan.'
      : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!projectId || request.trim().length < 12) return;

    const res = await start.execute({ projectId, workflow, request: request.trim() });
    if (res?.run) {
      onLaunched?.();
      // The run exists and is durable; go watch it.
      router.push(`/runs/${res.run._id}`);
    }
  };

  if (!readyProjects.length) {
    return (
      <section className="panel p-4">
        <h2 className="text-[13px] font-semibold">Nothing to work on yet</h2>
        <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {projects.length
            ? 'A connected project is still being indexed. The workforce can start once it reports ready.'
            : 'The agents read your actual codebase, so a repository has to be connected first.'}
        </p>
        <div className="mt-3">
          <Button size="sm" onClick={() => router.push('/projects')}>
            Connect a repository
          </Button>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="panel rail-top p-4" style={{ ['--accent' as string]: 'var(--series-1)' }}>
      <h2 className="mb-3 text-[13px] font-semibold">Commission work</h2>

      <div className="space-y-3">
        <Field label="Repository">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {readyProjects.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Workflow">
          <Select value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
            {definitions.map((w) => (
              <option key={w.key} value={w.key}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="What do you want done?" hint={selected?.trigger}>
          <TextArea
            rows={3}
            value={request}
            required
            minLength={12}
            maxLength={20_000}
            aria-invalid={requestError ? true : undefined}
            aria-describedby={requestError ? 'request-error' : undefined}
            placeholder={EXAMPLES[workflow] ?? 'Describe the work in plain language…'}
            onChange={(e) => setRequest(e.target.value)}
            onBlur={() => setTouched(true)}
          />
        </Field>
        {requestError && (
          <p id="request-error" className="text-[11px]" style={{ color: 'var(--status-critical)' }}>
            {requestError}
          </p>
        )}
        {!request.trim() && EXAMPLES[workflow] && (
          <button
            type="button"
            onClick={() => setRequest(EXAMPLES[workflow]!)}
            className="text-[11px] underline underline-offset-2"
            style={{ color: 'var(--series-1)' }}
          >
            Use the example request
          </button>
        )}
      </div>

      {selected && <PlanPreview definition={selected} />}

      {start.error && (
        <div className="mt-3">
          <ErrorNote message={start.error} />
        </div>
      )}

      <div className="mt-3 space-y-2">
        {project && (
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Agents will read and write <strong style={{ color: 'var(--text-secondary)' }}>{project.name}</strong>
            {project.profile?.testCommand && (
              <>
                {' '}
                and verify with <code className="hud">{project.profile.testCommand}</code>
              </>
            )}
            .
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={start.pending || !projectId || request.trim().length < 12}
          className="w-full"
        >
          {start.pending ? 'Dispatching…' : 'Start run'}
        </Button>
      </div>
    </form>
  );
}

/**
 * The plan, before you commit to it.
 *
 * Shows the actual agents in execution order with their real silhouettes, so the
 * preview and the run you are about to watch use the same visual language.
 * Conditional and gated steps are marked, because "will this pause and wait for
 * me?" changes whether you start it before stepping away.
 */
function PlanPreview({ definition }: { definition: WorkflowDefinition }) {
  const gated = definition.steps.filter((s) => s.requiresApproval).length;

  return (
    <div className="mt-3 rounded-lg border p-3" style={{ background: 'var(--surface-0)' }}>
      <p className="eyebrow mb-2.5">Plan · {definition.steps.length} steps</p>

      <div className="flex flex-wrap items-start gap-x-0.5 gap-y-2">
        {definition.steps.map((step, index) => {
          const identity = agentIdentity(step.agent);
          return (
            <div key={step.id} className="flex items-start">
              {index > 0 && (
                <span aria-hidden className="mt-4 px-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  →
                </span>
              )}
              <motion.div
                className="flex w-[52px] flex-col items-center gap-0.5 text-center"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.04 }}
                title={`${step.name} — ${identity.role}`}
              >
                <AgentAvatar agentKey={step.agent} state="idle" size={34} showMonogram={false} />
                <span className="text-[9px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                  {identity.short}
                </span>
                <span className="flex gap-0.5 text-[9px]">
                  {step.conditional && (
                    <span aria-hidden title="Runs only if the plan says it is needed">
                      ◑
                    </span>
                  )}
                  {step.requiresApproval && (
                    <span aria-hidden title="Pauses for your approval" style={{ color: 'var(--status-warning)' }}>
                      ⏸
                    </span>
                  )}
                </span>
              </motion.div>
            </div>
          );
        })}
      </div>

      <p className="mt-2.5 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {gated > 0 ? (
          <>
            <span style={{ color: 'var(--status-warning)' }}>⏸ {gated} step{gated === 1 ? '' : 's'} will pause</span>{' '}
            and wait for your approval before changing anything.{' '}
          </>
        ) : (
          'No approval gates in this workflow — it runs to completion unless something blocks. '
        )}
        ◑ marks steps skipped automatically when the plan says they are not needed.
      </p>
    </div>
  );
}
