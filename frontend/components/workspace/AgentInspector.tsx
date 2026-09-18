'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { AgentAvatar, AgentStateBadge } from '@/components/agents/AgentAvatar';
import { AGENT_STATE, agentIdentity, taskState, type AgentState } from '@/lib/agent-visuals';
import { timeAgo } from '@/lib/format';
import type { Agent, Task } from '@/lib/types';

/**
 * The inspector: detail about one agent, slid in over the world.
 *
 * Contextual rather than structural — it exists only while an agent is selected,
 * and it never takes the canvas away. That is the difference between a spatial
 * interface with details available and a dashboard with a chart in it.
 *
 * ## Focus handling
 * The audit found the task drawer had no dialog role, no focus trap, no Escape
 * handling and no return-focus. This is a non-modal complementary region rather
 * than a dialog — the canvas behind it stays interactive on purpose, so trapping
 * focus would be wrong — but Escape closes it and focus returns to where it came
 * from, which is the part that actually matters for keyboard users.
 */
export function AgentInspector({
  agentKey,
  state,
  activity,
  agent,
  tasks,
  onClose,
}: {
  agentKey: string;
  state: AgentState;
  activity?: string;
  agent?: Agent;
  tasks: Task[];
  onClose: () => void;
}) {
  const identity = agentIdentity(agentKey);
  const style = AGENT_STATE[state];
  const panelRef = useRef<HTMLElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusTo.current = document.activeElement as HTMLElement;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Return focus to whatever opened this, so keyboard navigation does not
      // dump the user at the top of the document.
      returnFocusTo.current?.focus?.();
    };
  }, [onClose]);

  const openTasks = tasks.filter((t) => !['done', 'cancelled'].includes(t.status));

  return (
    <motion.aside
      ref={panelRef}
      aria-label={`${identity.role} details`}
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 32 }}
      className="pointer-events-auto absolute right-5 top-20 z-20 flex max-h-[calc(100dvh-11rem)] w-[min(340px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-xl border backdrop-blur-md"
      style={{
        background: 'color-mix(in srgb, var(--surface-1) 93%, transparent)',
        boxShadow: 'var(--elev-3)',
        borderColor: `color-mix(in srgb, ${identity.color} 32%, var(--border))`,
      }}
    >
      <header className="flex items-start gap-3 border-b p-3.5">
        <AgentAvatar agentKey={agentKey} state={state} size={52} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold leading-tight">{identity.role}</h2>
          <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            {identity.purpose}
          </p>
          <div className="mt-1.5">
            <AgentStateBadge state={state} />
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="rounded-md px-1.5 py-0.5 text-[13px] transition-colors hover:text-[var(--text-primary)]"
          style={{ color: 'var(--text-muted)' }}
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {activity && (
          <p className="mb-3 text-[12px] leading-snug" style={{ color: style.color }}>
            <span className="eyebrow mr-1.5">now</span>
            {activity}
          </p>
        )}

        {/*
          Capability, stated as boundaries rather than features. "What can this
          thing do to my repository" is the question an operator actually has,
          and the honest answer is the set of paths it may write.
        */}
        {agent && (
          <section className="mb-4">
            <p className="eyebrow mb-1.5">Authority</p>
            <dl className="space-y-1.5 text-[11px]">
              <Row
                label="Writes"
                value={
                  agent.permissions.canWrite
                    ? agent.permissions.writePaths.join(', ')
                    : 'nothing — advisory role'
                }
                accent={agent.permissions.canWrite ? undefined : 'var(--text-muted)'}
              />
              <Row
                label="Commands"
                value={
                  agent.permissions.canRunCommands
                    ? agent.permissions.allowedCommands.join(', ') || 'none'
                    : 'not permitted'
                }
              />
              <Row label="Git" value={agent.permissions.canWriteGit ? 'branch, commit, push' : 'read only'} />
              {agent.permissions.requiresHumanApproval && (
                <Row label="Gate" value="never runs unattended" accent="var(--status-warning)" />
              )}
            </dl>
          </section>
        )}

        <section>
          <p className="eyebrow mb-1.5">
            {openTasks.length ? `Open work · ${openTasks.length}` : 'Recent work'}
          </p>
          {tasks.length === 0 ? (
            <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              Nothing assigned yet.
            </p>
          ) : (
            <ul className="space-y-1">
              {(openTasks.length ? openTasks : tasks).slice(0, 8).map((task) => (
                <li key={task._id}>
                  <TaskRow task={task} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {agent && agent.stats.runs > 0 && (
          <section className="mt-4 border-t pt-3">
            <p className="eyebrow mb-1.5">Lifetime</p>
            <div className="hud grid grid-cols-3 gap-2 text-[11px]">
              <Stat label="runs" value={agent.stats.runs} />
              <Stat label="tools" value={agent.stats.toolCalls} />
              <Stat
                label="tokens"
                value={compact(agent.stats.inputTokens + agent.stats.outputTokens)}
              />
            </div>
          </section>
        )}
      </div>
    </motion.aside>
  );
}

function TaskRow({ task }: { task: Task }) {
  const href = task.workflowRunId ? `/runs/${task.workflowRunId}` : `/projects/${task.projectId}`;
  return (
    <Link
      href={href}
      className="flex items-start gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-[var(--surface-2)]"
    >
      <span className="mt-0.5 shrink-0">
        <AgentStateBadge state={taskState(task.status)} compact />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
          {task.title}
        </span>
        <span className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {timeAgo(task.createdAt)}
        </span>
      </span>
    </Link>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0" style={{ color: 'var(--text-muted)' }}>
        {label}
      </dt>
      <dd className="hud min-w-0 flex-1 break-words" style={{ color: accent ?? 'var(--text-secondary)' }}>
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
