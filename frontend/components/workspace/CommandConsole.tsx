'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '@/lib/api';
import { useAction, usePoll } from '@/lib/hooks';
import { agentIdentity } from '@/lib/agent-visuals';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import type { Project, WorkflowDefinition } from '@/lib/types';

/**
 * The command console: where a request enters the system.
 *
 * A single floating input at the bottom of the world, not a form in a card. You
 * describe the work, and the request visibly travels into the room and reaches
 * the orchestrator — the skill's initial-request sequence, driven by a real
 * event rather than played for decoration.
 *
 * ## What it still refuses to hide
 * Expanding the console shows the plan before you commit to it: which agents
 * will run, in what order, which steps pause for approval, and which repository
 * is about to be edited. The audit's finding was that operators discovered the
 * blast radius *after* a run started touching a repository. Being a beautiful
 * floating console is not a reason to stop answering that question.
 *
 * ## Submission
 * The backend accepts and queues the run, returning immediately, so this
 * navigates to the mission view rather than blocking on a workflow that takes
 * minutes.
 */

/**
 * Grow the console to fit what is typed, up to a ceiling.
 *
 * A fixed single row truncates a real request as you write it, and a fixed tall
 * box wastes the world behind it when empty. Resetting the height before
 * measuring is required — otherwise `scrollHeight` only ever grows.
 */
function autoGrow(element: HTMLTextAreaElement): void {
  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
}

const EXAMPLES: Record<string, string> = {
  'feature-development':
    'Add a payment feature: users can pay for a subscription with Stripe, see their payment history, and download invoices.',
  'bug-fixing': 'Users occasionally get charged twice when they double-click the Pay button.',
  'code-review':
    'Review the changes on the current branch for correctness and architectural consistency.',
};

export function CommandConsole({
  projects,
  selectedProjectId,
  onSelectProject,
  onDispatch,
}: {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  /** Called with the request text the moment it is accepted, to play the entry animation. */
  onDispatch: (request: string) => void;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [request, setRequest] = useState('');
  const [workflow, setWorkflow] = useState('');

  const workflows = usePoll((signal) => api.listWorkflows(signal), { intervalMs: 0 });
  const definitions = useMemo(() => workflows.data?.workflows ?? [], [workflows.data]);
  const readyProjects = useMemo(() => projects.filter((p) => p.status === 'ready'), [projects]);

  const start = useAction(api.startWorkflow);
  const definition = definitions.find((w) => w.key === workflow);
  const project = readyProjects.find((p) => p._id === selectedProjectId);

  useEffect(() => {
    if (!workflow && definitions.length) setWorkflow(definitions[0]!.key);
  }, [definitions, workflow]);

  // Keep the selection valid: a project that is deleted or stops being ready
  // must not stay silently selected and produce a confusing 409 at submit.
  useEffect(() => {
    if (!readyProjects.length) return;
    if (!readyProjects.some((p) => p._id === selectedProjectId)) {
      onSelectProject(readyProjects[0]!._id);
    }
  }, [readyProjects, selectedProjectId, onSelectProject]);

  // `/` focuses the console from anywhere, the way a command palette does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if (event.key === '/' && !typing) {
        event.preventDefault();
        setExpanded(true);
        inputRef.current?.focus();
      }
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const valid = request.trim().length >= 12 && Boolean(selectedProjectId);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const text = request.trim();
    const res = await start.execute({ projectId: selectedProjectId!, workflow, request: text });
    if (res?.run) {
      onDispatch(text);
      setRequest('');
      setExpanded(false);
      // Let the entry animation land before the route changes.
      setTimeout(() => router.push(`/runs/${res.run._id}`), 900);
    }
  };

  if (!readyProjects.length) {
    return (
      <div className="pointer-events-auto absolute bottom-20 left-1/2 z-20 w-[min(560px,calc(100vw-2.5rem))] -translate-x-1/2 lg:bottom-6">
        <div
          className="rounded-xl border px-4 py-3 text-center backdrop-blur-md"
          style={{ background: 'color-mix(in srgb, var(--surface-1) 88%, transparent)', boxShadow: 'var(--elev-3)' }}
        >
          <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
            {projects.length
              ? 'A repository is still being indexed. The workforce wakes when it reports ready.'
              : 'Connect a repository to wake the workforce.'}
          </p>
          <button
            type="button"
            onClick={() => router.push('/projects')}
            className="mt-2 rounded-lg px-3 py-1.5 text-[12px] font-medium text-white"
            style={{ background: 'var(--series-1)' }}
          >
            Connect a repository
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-auto absolute bottom-20 left-1/2 z-20 w-[min(680px,calc(100vw-2.5rem))] -translate-x-1/2 lg:bottom-6">
      <AnimatePresence>
        {expanded && definition && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            className="mb-2 rounded-xl border p-3.5 backdrop-blur-md"
            style={{
              background: 'color-mix(in srgb, var(--surface-1) 92%, transparent)',
              boxShadow: 'var(--elev-3)',
            }}
          >
            <Dispatch
              definitions={definitions}
              definition={definition}
              workflow={workflow}
              onWorkflow={setWorkflow}
              projects={readyProjects}
              selectedProjectId={selectedProjectId}
              onSelectProject={onSelectProject}
              project={project}
              example={!request.trim() ? EXAMPLES[workflow] : undefined}
              onUseExample={() => {
                const text = EXAMPLES[workflow];
                if (!text) return;
                setRequest(text);
                inputRef.current?.focus();
                if (inputRef.current) autoGrow(inputRef.current);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <form
        onSubmit={submit}
        className="flex items-end gap-2 rounded-xl border p-2 backdrop-blur-md transition-shadow"
        style={{
          background: 'color-mix(in srgb, var(--surface-1) 90%, transparent)',
          boxShadow: expanded ? 'var(--elev-3)' : 'var(--elev-2)',
          borderColor: expanded ? 'color-mix(in srgb, var(--series-1) 40%, var(--border))' : 'var(--border)',
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide dispatch options' : 'Show dispatch options'}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[11px] transition-colors"
          style={{ color: 'var(--text-muted)', background: 'var(--surface-0)' }}
        >
          <span aria-hidden>{expanded ? '▾' : '▸'}</span>
          <span className="hidden sm:inline">{definition?.name ?? 'Workflow'}</span>
        </button>

        <label className="sr-only" htmlFor="command-input">
          Describe the work to commission
        </label>
        <textarea
          id="command-input"
          ref={inputRef}
          rows={1}
          value={request}
          onChange={(e) => {
            setRequest(e.target.value);
            autoGrow(e.currentTarget);
          }}
          onFocus={(e) => {
            setExpanded(true);
            autoGrow(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
          }}
          // Short enough to fit one line at the console's narrowest width. The
          // full worked example lives behind "Use an example" below, so the
          // placeholder never clips mid-sentence.
          placeholder="Describe the work…   press / to focus"
          className="max-h-40 min-h-8 flex-1 resize-none overflow-y-auto bg-transparent py-1.5 text-[13px] leading-snug outline-none placeholder:text-[var(--text-muted)]"
          style={{ color: 'var(--text-primary)' }}
        />

        <button
          type="submit"
          disabled={!valid || start.pending}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
          style={{ background: 'var(--series-1)' }}
        >
          {start.pending ? 'Dispatching…' : 'Dispatch'}
          <span aria-hidden className="hidden text-[10px] opacity-70 sm:inline">⌘⏎</span>
        </button>
      </form>

      <AnimatePresence>
        {start.error && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            role="alert"
            className="mt-2 rounded-lg border px-3 py-2 text-[11.5px] backdrop-blur-md"
            style={{
              background: 'color-mix(in srgb, var(--surface-1) 90%, transparent)',
              borderColor: 'color-mix(in srgb, var(--status-critical) 40%, transparent)',
              color: 'var(--status-critical)',
            }}
          >
            {start.error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The plan, the scope, and the gates — shown before dispatch, never after. */
function Dispatch({
  definitions,
  definition,
  workflow,
  onWorkflow,
  projects,
  selectedProjectId,
  onSelectProject,
  project,
  example,
  onUseExample,
}: {
  definitions: WorkflowDefinition[];
  definition: WorkflowDefinition;
  workflow: string;
  onWorkflow: (key: string) => void;
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  project?: Project;
  example?: string;
  onUseExample: () => void;
}) {
  const gated = definition.steps.filter((s) => s.requiresApproval).length;

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {definitions.map((w) => (
          <button
            key={w.key}
            type="button"
            onClick={() => onWorkflow(w.key)}
            className="rounded-full border px-2.5 py-1 text-[11px] transition-colors"
            style={{
              background: w.key === workflow ? 'var(--surface-2)' : 'transparent',
              color: w.key === workflow ? 'var(--text-primary)' : 'var(--text-muted)',
              borderColor: w.key === workflow ? 'var(--border-strong)' : 'var(--border)',
            }}
            title={w.description}
          >
            {w.name}
          </button>
        ))}
      </div>

      {projects.length > 1 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {projects.map((p) => (
            <button
              key={p._id}
              type="button"
              onClick={() => onSelectProject(p._id)}
              className="hud max-w-[200px] truncate rounded-full border px-2.5 py-1 text-[11px] transition-colors"
              style={{
                background: p._id === selectedProjectId ? 'var(--surface-2)' : 'transparent',
                color: p._id === selectedProjectId ? 'var(--text-primary)' : 'var(--text-muted)',
                borderColor: p._id === selectedProjectId ? 'var(--border-strong)' : 'var(--border)',
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      {/* The chain of agents that will actually run. */}
      <div className="mt-3 flex flex-wrap items-start gap-x-0.5 gap-y-2">
        {definition.steps.map((step, index) => {
          const identity = agentIdentity(step.agent);
          return (
            <div key={step.id} className="flex items-start">
              {index > 0 && (
                <span aria-hidden className="mt-3.5 px-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  →
                </span>
              )}
              <motion.div
                className="flex w-12 flex-col items-center gap-0.5 text-center"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.035 }}
                title={`${step.name} — ${identity.role}`}
              >
                <AgentAvatar agentKey={step.agent} state="idle" size={30} showMonogram={false} />
                <span className="text-[9px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                  {identity.short}
                </span>
                {(step.conditional || step.requiresApproval) && (
                  <span className="flex gap-0.5 text-[9px]">
                    {step.conditional && <span aria-hidden title="Skipped when not needed">◑</span>}
                    {step.requiresApproval && (
                      <span aria-hidden title="Pauses for approval" style={{ color: 'var(--status-warning)' }}>
                        ⏸
                      </span>
                    )}
                  </span>
                )}
              </motion.div>
            </div>
          );
        })}
      </div>

      <p className="mt-2.5 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {project && (
          <>
            Agents will read and write <strong style={{ color: 'var(--text-secondary)' }}>{project.name}</strong>
            {project.profile?.testCommand && (
              <>
                , verifying with <code className="hud">{project.profile.testCommand}</code>
              </>
            )}
            .{' '}
          </>
        )}
        {gated > 0 ? (
          <span style={{ color: 'var(--status-warning)' }}>
            {gated} step{gated === 1 ? '' : 's'} will pause for your approval.
          </span>
        ) : (
          'No approval gates — this runs to completion unless something blocks.'
        )}
      </p>

      {example && (
        <button
          type="button"
          onClick={onUseExample}
          className="mt-2 block max-w-full truncate text-left text-[11px] underline underline-offset-2"
          style={{ color: 'var(--series-1)' }}
          title={example}
        >
          Use an example: “{example}”
        </button>
      )}
    </>
  );
}
