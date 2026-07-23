'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { usePoll, useLocalState, useAction } from '@/lib/hooks';
import { agentColor } from '@/lib/design';
import { formatNumber, estimateCost } from '@/lib/format';
import {
  Badge, Button, Card, ErrorNote, Field, Mono, OutputBlock,
  SectionTitle, Select, Spinner, TextArea,
} from '@/components/ui';
import { AgentNetwork } from '@/components/viz/AgentNetwork';
import { PermissionMatrix } from '@/components/viz/PermissionMatrix';
import { UsageChart } from '@/components/viz/UsageChart';

/**
 * The Org: who the agents are, what each is allowed to do, and a console for
 * talking to one directly.
 */
export default function OrgPage() {
  const agents = usePoll(() => api.listAgents(), 8000);
  const projects = usePoll(() => api.listProjects(), 15_000);
  const [selected, setSelected] = useState<string | null>(null);

  if (agents.error) return <ErrorNote message={agents.error} onRetry={agents.refresh} />;
  if (!agents.data) return <Spinner label="Loading the roster" />;

  const selectedAgent = agents.data.agents.find((a) => a.key === selected) ?? null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">The Organization</h1>
        <p className="text-xs text-[var(--text-muted)]">
          Six specialised roles. Each has its own prompt, tools and permission scope — enforced in
          code, not by asking nicely.
        </p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.1fr_1fr]">
        <Card>
          <SectionTitle title="Reporting structure & handoffs" />
          <AgentNetwork
            agents={agents.data.agents}
            onSelect={(k) => setSelected(k === selected ? null : k)}
            selected={selected}
          />
        </Card>

        <div className="space-y-5">
          {selectedAgent ? (
            <AgentDetail
              agent={selectedAgent}
              projects={projects.data?.projects ?? []}
              onClose={() => setSelected(null)}
            />
          ) : (
            <Card>
              <SectionTitle
                title="Select a role"
                hint="Click any node in the chart to see its prompt scope, tools, permissions, and to task it directly."
              />
              <ul className="space-y-2">
                {agents.data.agents.map((a) => (
                  <li key={a.key}>
                    <button
                      onClick={() => setSelected(a.key)}
                      className="w-full rounded-lg border p-2.5 text-left hover:border-[var(--border-strong)]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-xs font-medium">
                          <span
                            aria-hidden
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ background: agentColor(a.key) }}
                          />
                          {a.name}
                        </span>
                        <span className="tabular text-[10px] text-[var(--text-muted)]">
                          {a.stats.runs} runs
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] text-[var(--text-muted)]">
                        {a.description}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <Card>
        <SectionTitle
          title="Permission matrix"
          hint="What each role can and cannot touch. This is the platform's safety model, made visible."
        />
        <PermissionMatrix agents={agents.data.agents} />
      </Card>

      <Card>
        <SectionTitle title="Workload by role" />
        <UsageChart agents={agents.data.agents} />
      </Card>
    </div>
  );
}

function AgentDetail({
  agent,
  projects,
  onClose,
}: {
  agent: import('@/lib/types').Agent;
  projects: import('@/lib/types').Project[];
  onClose: () => void;
}) {
  const [projectId, setProjectId] = useLocalState<string>('aiec-project', '');
  const [prompt, setPrompt] = useState('');
  const run = useAction(api.runAgent);
  const [result, setResult] = useState<import('@/lib/types').AgentRunResult | null>(null);

  const readyProjects = projects.filter((p) => p.status === 'ready');
  const effectiveProject = projectId || readyProjects[0]?._id || '';

  const ask = async () => {
    if (!effectiveProject || !prompt.trim()) return;
    const res = await run.execute({
      agentKey: agent.key,
      projectId: effectiveProject,
      prompt: prompt.trim(),
    });
    if (res) setResult(res.result);
  };

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <span
            aria-hidden
            className="mt-1 h-3 w-3 shrink-0 rounded-full"
            style={{ background: agentColor(agent.key) }}
          />
          <div>
            <h2 className="text-sm font-semibold">{agent.name}</h2>
            <p className="text-[11px] text-[var(--text-muted)]">{agent.role}</p>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>✕</Button>
      </div>

      <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{agent.description}</p>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Metric label="Runs" value={agent.stats.runs} />
        <Metric label="Tool calls" value={agent.stats.toolCalls} />
        <Metric
          label="Spend est."
          value={estimateCost(agent.stats.inputTokens, agent.stats.outputTokens)}
        />
      </div>

      <Block title="Capabilities">
        <div className="flex flex-wrap gap-1">
          {agent.capabilities.map((c) => (
            <Badge key={c}>{c}</Badge>
          ))}
        </div>
      </Block>

      <Block title={`Tools (${agent.tools.length})`}>
        <div className="flex flex-wrap gap-1">
          {agent.tools.map((t) => (
            <Mono key={t}>{t}</Mono>
          ))}
        </div>
      </Block>

      <Block title="Write scope">
        {agent.permissions.canWrite ? (
          <div className="flex flex-wrap gap-1">
            {agent.permissions.writePaths.slice(0, 12).map((p) => (
              <Mono key={p}>{p}</Mono>
            ))}
            {agent.permissions.writePaths.length > 12 && (
              <span className="text-[10px] text-[var(--text-muted)]">
                +{agent.permissions.writePaths.length - 12} more
              </span>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-[var(--text-muted)]">
            Read-only. This role advises and plans; it cannot modify any file.
          </p>
        )}
      </Block>

      <Block title="Explicitly denied">
        <div className="flex flex-wrap gap-1">
          {agent.permissions.deniedPaths.slice(0, 10).map((p) => (
            <span
              key={p}
              className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono text-[10px]"
              style={{ color: 'var(--status-critical)' }}
            >
              {p}
            </span>
          ))}
        </div>
      </Block>

      {agent.permissions.canRunCommands && (
        <Block title="Command allowlist">
          <div className="flex flex-wrap gap-1">
            {agent.permissions.allowedCommands.map((c) => (
              <Mono key={c}>{c}</Mono>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-[var(--text-muted)]">
            Executed without a shell — pipes and chaining are not expressible.
          </p>
        </Block>
      )}

      {/* Direct console */}
      <div className="mt-4 border-t pt-3">
        <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          Task this agent directly
        </p>
        {!readyProjects.length ? (
          <p className="text-[11px] text-[var(--text-muted)]">
            Connect a project first — agents work against a real codebase.
          </p>
        ) : (
          <>
            <div className="mb-2">
              <Field label="Project">
                <Select value={effectiveProject} onChange={(e) => setProjectId(e.target.value)}>
                  {readyProjects.map((p) => (
                    <option key={p._id} value={p._id}>{p.name}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <TextArea
              rows={2}
              placeholder={
                agent.key === 'engineering-manager'
                  ? 'How is authentication implemented here, and what would adding SSO involve?'
                  : 'Ask this agent to analyse or do something…'
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[10px] text-[var(--text-muted)]">
                {run.pending ? 'Agent is working…' : `Runs at effort: ${agent.effort}`}
              </span>
              <Button size="sm" variant="primary" onClick={ask} disabled={run.pending || !prompt.trim()}>
                {run.pending ? 'Working…' : 'Send'}
              </Button>
            </div>
            {run.error && <p className="mt-2 text-[11px]" style={{ color: 'var(--status-critical)' }}>{run.error}</p>}
            {result && (
              <div className="mt-3">
                <p className="mb-1 text-[10px] text-[var(--text-muted)]">
                  {result.iterations} iterations · {result.usage.toolCalls} tool calls ·{' '}
                  {formatNumber(result.usage.inputTokens)}/{formatNumber(result.usage.outputTokens)} tokens
                </p>
                {result.toolCalls.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {result.toolCalls.map((tc, i) => (
                      <span
                        key={i}
                        className="rounded border px-1 py-0.5 font-mono text-[9px]"
                        style={{
                          color: tc.ok ? 'var(--status-good)' : 'var(--status-critical)',
                          borderColor: tc.ok ? 'var(--status-good)' : 'var(--status-critical)',
                        }}
                        title={tc.summary}
                      >
                        {tc.ok ? '✓' : '✕'} {tc.name}
                      </span>
                    ))}
                  </div>
                )}
                <OutputBlock text={result.output || '(no output)'} maxHeight={300} />
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-[var(--surface-2)] px-2 py-1.5">
      <p className="tabular text-sm font-semibold">{value}</p>
      <p className="text-[10px] text-[var(--text-muted)]">{label}</p>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 border-t pt-2.5">
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {title}
      </p>
      {children}
    </div>
  );
}
