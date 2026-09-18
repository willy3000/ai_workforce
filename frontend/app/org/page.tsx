'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '@/lib/api';
import { usePoll } from '@/lib/hooks';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { agentIdentity, allAgentIdentities, MOTION } from '@/lib/agent-visuals';
import { ErrorNote, Spinner } from '@/components/ui';
import type { Agent } from '@/lib/types';

/**
 * The roster: who is on the team and what each of them is allowed to do.
 *
 * Framed as *authority*, not features. The question an operator actually has
 * before letting this loose on a repository is "what can this thing change",
 * and the honest answer is a role's write scope, its command allowlist and
 * whether it can push. Listing capabilities as marketing bullets would answer a
 * question nobody asked.
 *
 * Each role keeps the silhouette and colour it has everywhere else, so the
 * roster teaches the vocabulary the workspace and the missions list assume.
 */
export default function RosterPage() {
  const agents = usePoll((signal) => api.listAgents(signal), { intervalMs: 60_000 });
  const [expanded, setExpanded] = useState<string | null>(null);

  if (agents.loading && !agents.data) return <Spinner label="Loading roster" />;
  if (agents.error && !agents.data) return <ErrorNote message={agents.error} onRetry={agents.refresh} />;

  const roster = agents.data?.agents ?? [];
  // Definition order, not API order, so the team always reads the same way.
  const ordered = allAgentIdentities()
    .map((identity) => roster.find((a) => a.key === identity.key))
    .filter((a): a is Agent => Boolean(a));

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Roster</p>
        <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight">Six specialists, and their limits</h1>
        <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Every role carries a fixed permission profile. It is enforced in the platform, not
          requested in a prompt — a model that decides it would be helpful to edit the Dockerfile
          gets a permission error, not a Dockerfile.
        </p>
      </header>

      <ul className="grid gap-3 lg:grid-cols-2">
        {ordered.map((agent, index) => (
          <motion.li
            key={agent.key}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05, duration: 0.3 }}
          >
            <RosterCard
              agent={agent}
              expanded={expanded === agent.key}
              onToggle={() => setExpanded(expanded === agent.key ? null : agent.key)}
            />
          </motion.li>
        ))}
      </ul>

      <section className="rounded-xl border p-4" style={{ background: 'var(--surface-1)' }}>
        <h2 className="text-[13px] font-semibold">What none of them can do</h2>
        <ul className="mt-2 space-y-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {[
            'Read a file matching the secret policy — .env, keys, credentials — at any point, including during indexing.',
            'Write outside its own declared paths, even via a path that traverses through one (frontend/../backend is denied).',
            'Call a tool its role does not list, even if the model names it directly.',
            'Publish a pull request without passing the approval gate the workflow defines.',
            'See the platform’s own credentials: child processes inherit an allowlisted environment only.',
          ].map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden style={{ color: 'var(--status-good)' }}>
                ✓
              </span>
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Agent commands are still Turing-complete. Isolation depends on{' '}
          <code className="hud">TERMINAL_SANDBOX_COMMAND</code> being configured — see{' '}
          <Link href="/pipeline" className="underline underline-offset-2" style={{ color: 'var(--series-1)' }}>
            Internals
          </Link>
          .
        </p>
      </section>
    </div>
  );
}

function RosterCard({
  agent,
  expanded,
  onToggle,
}: {
  agent: Agent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const identity = agentIdentity(agent.key);
  const { permissions } = agent;

  return (
    <div
      className="h-full rounded-xl border p-4"
      style={{
        background: 'var(--surface-1)',
        borderColor: `color-mix(in srgb, ${identity.color} 22%, var(--border))`,
      }}
    >
      <div className="flex items-start gap-3.5">
        <AgentAvatar agentKey={agent.key} state="idle" size={56} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold leading-tight">{identity.role}</h2>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {agent.name}
          </p>
          <p className="mt-1.5 text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            {identity.purpose}
          </p>
        </div>
      </div>

      {/* Authority, stated as three plain answers. */}
      <dl className="mt-3.5 space-y-2 border-t pt-3 text-[11.5px]">
        <Authority
          label="Can change"
          value={permissions.canWrite ? permissions.writePaths.join(', ') : 'nothing — advisory only'}
          tone={permissions.canWrite ? 'normal' : 'muted'}
        />
        <Authority
          label="Can run"
          value={
            permissions.canRunCommands
              ? permissions.allowedCommands.join(', ') || 'no commands allowlisted'
              : 'no commands'
          }
          tone={permissions.canRunCommands ? 'normal' : 'muted'}
        />
        <Authority
          label="Can publish"
          value={permissions.canWriteGit ? 'branch, commit, push, open PR' : 'no — read-only on git'}
          tone={permissions.canWriteGit ? 'warn' : 'muted'}
        />
        {permissions.requiresHumanApproval && (
          <Authority label="Gate" value="never runs without your approval" tone="warn" />
        )}
      </dl>

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="mt-3 text-[11px] underline underline-offset-2"
        style={{ color: 'var(--text-muted)' }}
      >
        {expanded ? 'Hide' : 'Show'} tools, model and activity
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: MOTION.panel }}
            className="overflow-hidden"
          >
            <div className="mt-3 space-y-3 border-t pt-3">
              <div>
                <p className="eyebrow mb-1.5">Tools · {agent.tools.length}</p>
                <div className="flex flex-wrap gap-1">
                  {agent.tools.map((tool) => (
                    <code
                      key={tool}
                      className="hud rounded px-1.5 py-0.5 text-[10px]"
                      style={{ background: 'var(--surface-0)', color: 'var(--text-muted)' }}
                    >
                      {tool}
                    </code>
                  ))}
                </div>
              </div>

              <div className="hud grid grid-cols-4 gap-2 text-[11px]">
                <Stat label="runs" value={agent.stats.runs} />
                <Stat label="tools" value={agent.stats.toolCalls} />
                <Stat label="in" value={compact(agent.stats.inputTokens)} />
                <Stat label="out" value={compact(agent.stats.outputTokens)} />
              </div>

              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Model <span className="hud">{agent.model}</span> · effort{' '}
                <span className="hud">{agent.effort}</span> · max{' '}
                <span className="hud">{permissions.maxToolCalls}</span> tool calls per run
              </p>

              {permissions.deniedPaths.length > 0 && (
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Explicitly denied:{' '}
                  <span className="hud">{permissions.deniedPaths.join(', ')}</span>
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Authority({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'normal' | 'muted' | 'warn';
}) {
  const color = {
    normal: 'var(--text-secondary)',
    muted: 'var(--text-muted)',
    warn: 'var(--status-warning)',
  }[tone];

  return (
    <div className="flex gap-2.5">
      <dt className="w-20 shrink-0" style={{ color: 'var(--text-muted)' }}>
        {label}
      </dt>
      <dd className="hud min-w-0 flex-1 break-words" style={{ color }}>
        {value}
      </dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md px-2 py-1.5" style={{ background: 'var(--surface-0)' }}>
      <p className="eyebrow">{label}</p>
      <p className="mt-0.5 text-[13px] font-semibold leading-none">{value}</p>
    </div>
  );
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
