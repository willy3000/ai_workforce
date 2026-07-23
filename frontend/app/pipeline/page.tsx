'use client';

import { api } from '@/lib/api';
import { usePoll, useLocalState } from '@/lib/hooks';
import { formatNumber } from '@/lib/format';
import { Card, ErrorNote, SectionTitle, Select, Spinner, StatTile } from '@/components/ui';
import { DataFlowMap } from '@/components/viz/DataFlowMap';

/**
 * The Data Pipeline page: the platform explaining itself.
 *
 * Its job is to make the two claims in the architecture verifiable rather than
 * asserted — that the repository is never shipped to the model, and that every
 * tool call is checked before it has an effect.
 */
export default function PipelinePage() {
  const [projectId, setProjectId] = useLocalState<string>('aiec-project', '');
  const projects = usePoll(() => api.listProjects(), 15_000);
  const ready = usePoll(() => api.ready(), 15_000);

  const effectiveId = projectId || projects.data?.projects[0]?._id || '';
  const memory = usePoll(
    () => (effectiveId ? api.memory(effectiveId) : Promise.resolve(null)),
    10_000,
    [effectiveId],
  );
  const tasks = usePoll(
    () => (effectiveId ? api.listTasks(effectiveId) : Promise.resolve(null)),
    8000,
    [effectiveId],
  );
  const messages = usePoll(
    () => (effectiveId ? api.messages(effectiveId) : Promise.resolve(null)),
    8000,
    [effectiveId],
  );

  const project = projects.data?.projects.find((p) => p._id === effectiveId);

  if (projects.error) return <ErrorNote message={projects.error} onRetry={projects.refresh} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Data Pipeline</h1>
          <p className="text-xs text-[var(--text-muted)]">
            How a request becomes code: what is ingested, what is processed, what is stored, and
            what feeds back into the next run.
          </p>
        </div>
        <div className="w-56">
          <Select value={effectiveId} onChange={(e) => setProjectId(e.target.value)}>
            {(projects.data?.projects ?? []).map((p) => (
              <option key={p._id} value={p._id}>{p.name}</option>
            ))}
            {!projects.data?.projects.length && <option value="">No projects yet</option>}
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile
          label="Files indexed"
          value={project ? formatNumber(project.profile.fileCount) : '—'}
          sub="path + summary + symbols"
          glyph="▤"
        />
        <StatTile
          label="Memory entries"
          value={memory.data?.knowledge.length ?? '—'}
          sub="retrievable facts"
          accent="var(--series-5)"
          glyph="⬢"
        />
        <StatTile
          label="Decisions"
          value={memory.data?.decisions.length ?? '—'}
          sub="binding on all agents"
          accent="var(--series-1)"
          glyph="⚖"
        />
        <StatTile label="Tasks" value={tasks.data?.count ?? '—'} sub="with full history" glyph="▦" />
        <StatTile
          label="Messages"
          value={messages.data?.count ?? '—'}
          sub="inter-agent bus"
          glyph="⇄"
        />
      </div>

      <Card>
        <SectionTitle
          title="The pipeline"
          hint="Hover any stage for what it actually does. Counts are live for the selected project."
        />
        <DataFlowMap
          counts={{
            files: project?.profile.fileCount,
            knowledge: memory.data?.knowledge.length,
            tasks: tasks.data?.count,
            messages: messages.data?.count,
            decisions: memory.data?.decisions.length,
          }}
        />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <SectionTitle
            title="Why the repository is never sent to the model"
            hint="The single most important design constraint in the platform."
          />
          <div className="space-y-2.5 text-xs leading-relaxed text-[var(--text-secondary)]">
            <p>
              A naive agent stuffs the codebase into the prompt. That does not scale, costs the same
              whether or not the content is relevant, and buries the useful context in noise.
            </p>
            <p>Instead, each task gets:</p>
            <ul className="ml-1 space-y-1.5">
              {[
                ['the project profile', 'stack, conventions, build commands — so generated code fits'],
                ['binding decisions', 'injected unconditionally; an agent may not contradict them'],
                ['top-N memory entries', 'ranked against the task text by a weighted text index'],
                ['a shortlist of file paths', 'paths and summaries only — not contents'],
              ].map(([label, detail]) => (
                <li key={label} className="flex gap-2">
                  <span aria-hidden style={{ color: 'var(--series-5)' }}>→</span>
                  <span>
                    <span className="font-medium text-[var(--text-primary)]">{label}</span> — {detail}
                  </span>
                </li>
              ))}
            </ul>
            <p>
              The agent then pulls file contents on demand through tools. A 400-file repository costs
              the same prompt as a 40-file one.
            </p>
          </div>
        </Card>

        <Card>
          <SectionTitle
            title="Where the safety boundary sits"
            hint="Enforced in code at a single choke point, not by prompting."
          />
          <ol className="space-y-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {[
              ['Model emits a tool call', 'Untrusted output. Nothing has happened yet.'],
              ['PermissionGuard evaluates it', 'Deny rules win over allow. No rule means denied.'],
              ['Path is resolved and symlink-checked', 'Must stay inside the project workspace.'],
              ['Commands run without a shell', 'argv array + per-agent allowlist. Chaining is not expressible.'],
              ['Effect is recorded as an artifact', 'Attached to the task with the agent\'s stated reason.'],
            ].map(([step, detail], i) => (
              <li key={step} className="flex gap-2.5">
                <span
                  className="tabular flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold"
                  style={{ borderColor: 'var(--series-6)', color: 'var(--series-6)' }}
                >
                  {i + 1}
                </span>
                <span>
                  <span className="font-medium text-[var(--text-primary)]">{step}</span> — {detail}
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-3 border-t pt-2 text-[11px] text-[var(--text-muted)]">
            A denied call is not a crash: it returns to the model as a recoverable error, so the
            agent adapts — typically by handing the work to the role that owns that path.
          </p>
        </Card>
      </div>

      {ready.data && (
        <Card>
          <SectionTitle title="Platform configuration" />
          <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <Cfg label="Model" value={ready.data.config.model} />
            <Cfg label="Effort" value={ready.data.config.effort} />
            <Cfg
              label="Approval gates"
              value={ready.data.config.requireHumanApproval ? 'ON — every mutating step pauses' : 'off'}
              accent={ready.data.config.requireHumanApproval ? 'var(--status-warning)' : undefined}
            />
            <Cfg label="Registered tools" value={String(ready.data.registry.tools.length)} />
          </dl>
          <div className="mt-3 flex flex-wrap gap-1 border-t pt-2">
            {ready.data.registry.tools.map((t) => (
              <code
                key={t}
                className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]"
              >
                {t}
              </code>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Cfg({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-0.5 font-medium" style={accent ? { color: accent } : undefined}>
        {value}
      </dd>
    </div>
  );
}
