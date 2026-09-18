'use client';

import { useMemo } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { AgentAvatar, AgentStateBadge } from '@/components/agents/AgentAvatar';
import {
  AGENT_STATE,
  MOTION,
  agentIdentity,
  phaseForStep,
  stepState,
  type AgentState,
} from '@/lib/agent-visuals';
import type { WorkflowRun } from '@/lib/types';
import { duration } from '@/lib/format';

/**
 * A run as a process lane: the work moving through the workforce, left to right.
 *
 * ## Why a lane and not the hub
 * The orchestration canvas answers "who is in the system"; this answers "where
 * is *this* piece of work right now". A run is a sequence — the engine executes
 * steps in order, threading each output into the next prompt — so a lane is the
 * honest shape, and reading order does the work that a legend would otherwise
 * have to.
 *
 * ## What the reader gets without clicking
 *  - which step is executing, and which agent owns it;
 *  - which steps are done, skipped, blocked or failed, each with a glyph as well
 *    as a colour;
 *  - that work is flowing, via a packet travelling the connector that is
 *    currently handing off;
 *  - a semantic phase label rather than a fabricated percentage, because an
 *    agent loop genuinely does not know how many iterations it needs.
 *
 * ## Attempts
 * A retried step shows its attempt number. The audit noted workflow retries
 * replaced the step's task reference with no attempt lineage, so a reviewer
 * could not tell a first success from a third try.
 */

export interface RunFlowProps {
  run: WorkflowRun;
  onSelectStep?: (stepId: string) => void;
  selectedStepId?: string | null;
}

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'cancelling', 'awaiting_approval']);

export function RunFlow({ run, onSelectStep, selectedStepId }: RunFlowProps) {
  const reduceMotion = useReducedMotion();
  const runActive = ACTIVE_RUN_STATUSES.has(run.status);

  const stations = useMemo(() => {
    // The "next" step is the first pending one; it is the only pending step that
    // should read as queued rather than merely waiting its turn.
    const firstPendingIndex = run.steps.findIndex((s) => s.status === 'pending');
    return run.steps.map((step, index) => ({
      step,
      index,
      state: stepState(step.status, {
        runActive,
        isNext: index === firstPendingIndex,
        attempt: step.attempt,
      }),
    }));
  }, [run.steps, runActive]);

  const runningIndex = stations.findIndex((s) => s.state === 'running' || s.state === 'retrying');
  const completedCount = stations.filter((s) => s.state === 'completed').length;

  return (
    <div className="space-y-4">
      {/* Phase + progress header. Progress counts *completed steps*, which is a
          real quantity, rather than guessing at within-step progress. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">
            {runningIndex >= 0
              ? phaseForStep(runningIndex, stations.length)
              : run.status === 'completed'
                ? 'Finished'
                : AGENT_STATE[stations[0]?.state ?? 'idle'].label}
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {completedCount} of {stations.length} steps complete
          </span>
        </div>
        {run.usage && (run.usage.inputTokens > 0 || run.usage.toolCalls > 0) && (
          <span className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()} tokens ·{' '}
            {run.usage.toolCalls} tool calls
          </span>
        )}
      </div>

      <div
        className="relative overflow-x-auto rounded-xl border px-4 py-5"
        style={{
          background:
            'linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 70%, transparent), var(--surface-1))',
          borderColor: 'var(--border)',
        }}
      >
        <ol className="flex min-w-max items-start gap-0" role="list">
          {stations.map(({ step, index, state }) => {
            const identity = agentIdentity(step.agentKey);
            const style = AGENT_STATE[state];
            const isLast = index === stations.length - 1;
            const selected = selectedStepId === step.id;
            // A connector is "flowing" when the step before it just finished and
            // the step after it is working — that is a real handoff.
            const flowing =
              !isLast &&
              state === 'completed' &&
              (stations[index + 1]?.state === 'running' || stations[index + 1]?.state === 'retrying');

            return (
              <li key={step.id} className="flex items-start">
                <div className="flex w-[124px] flex-col items-center gap-1.5 text-center">
                  <button
                    type="button"
                    onClick={() => onSelectStep?.(step.id)}
                    className="flex flex-col items-center gap-1.5 rounded-lg px-1 py-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{
                      outlineColor: identity.color,
                      background: selected ? 'color-mix(in srgb, var(--border) 45%, transparent)' : undefined,
                    }}
                    aria-current={state === 'running' ? 'step' : undefined}
                    title={`${step.name} — ${identity.role}, ${style.label}. ${style.hint}`}
                  >
                    <AgentAvatar
                      agentKey={step.agentKey}
                      state={state}
                      size={52}
                      focused={state === 'running' || state === 'retrying'}
                      dimmed={state === 'idle' || state === 'cancelled'}
                    />
                    <span
                      className="line-clamp-2 text-[11px] font-medium leading-tight"
                      style={{ color: style.intensity === 0 ? 'var(--text-muted)' : 'var(--text-primary)' }}
                    >
                      {step.name}
                    </span>
                  </button>

                  <AgentStateBadge state={state} />

                  {/* Evidence under the station: attempt count, outcome when it
                      differs from the status, and how long it took. */}
                  <span className="text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                    {step.attempt && step.attempt > 1 && (
                      <span style={{ color: 'var(--status-warning)' }}>attempt {step.attempt} · </span>
                    )}
                    {step.outcome && step.outcome !== 'completed' ? (
                      <span style={{ color: style.color }}>{step.outcome.replace(/_/g, ' ')}</span>
                    ) : step.startedAt ? (
                      duration(step.startedAt, step.completedAt)
                    ) : (
                      '—'
                    )}
                  </span>
                </div>

                {!isLast && (
                  <Connector
                    active={flowing}
                    complete={state === 'completed' || state === 'cancelled'}
                    color={flowing ? 'var(--series-1)' : style.color}
                    reduceMotion={Boolean(reduceMotion)}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/**
 * The link between two stations.
 *
 * A travelling packet means "output is being handed to the next step right
 * now" — the run's context threading, made visible. A solid line means the
 * handoff already happened; a dotted one means it has not yet.
 */
function Connector({
  active,
  complete,
  color,
  reduceMotion,
}: {
  active: boolean;
  complete: boolean;
  color: string;
  reduceMotion: boolean;
}) {
  return (
    <div className="relative mt-[26px] h-[2px] w-9 shrink-0" aria-hidden>
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: complete ? color : 'var(--border-strong)',
          opacity: complete ? 0.55 : 0.4,
          backgroundImage: complete
            ? undefined
            : 'repeating-linear-gradient(90deg, var(--border-strong) 0 3px, transparent 3px 7px)',
        }}
      />
      {active && !reduceMotion && (
        <motion.span
          className="absolute top-1/2 h-2 w-2 -translate-y-1/2 rounded-full"
          style={{ background: color }}
          initial={{ left: 0, opacity: 0 }}
          animate={{ left: ['0%', '100%'], opacity: [0, 1, 1, 0] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', times: [0, 0.15, 0.8, 1] }}
        />
      )}
    </div>
  );
}

/**
 * The run's execution timeline as correlated events.
 *
 * The skill asks for a timeline the reader can map onto the canvas; hovering an
 * entry highlights the same step in the lane above via `selectedStepId`.
 * Timestamps are relative to the run's start, because "00:42" answers "how long
 * did this take" while a wall-clock time makes the reader do subtraction.
 */
export function RunTimeline({
  run,
  onSelectStep,
  selectedStepId,
}: {
  run: WorkflowRun;
  onSelectStep?: (stepId: string) => void;
  selectedStepId?: string | null;
}) {
  const origin = run.startedAt ?? run.createdAt;
  const originMs = new Date(origin).getTime();

  const events = useMemo(() => {
    const rows: { at: number; label: string; stepId?: string; state: AgentState }[] = [
      { at: 0, label: 'Request accepted', state: 'queued' },
    ];
    for (const step of run.steps) {
      const identity = agentIdentity(step.agentKey);
      if (step.startedAt) {
        rows.push({
          at: new Date(step.startedAt).getTime() - originMs,
          label: `${identity.role} started ${step.name}`,
          stepId: step.id,
          state: 'running',
        });
      }
      if (step.completedAt) {
        const state = stepState(step.status, { runActive: false, isNext: false });
        rows.push({
          at: new Date(step.completedAt).getTime() - originMs,
          label: `${identity.role} ${AGENT_STATE[state].label.toLowerCase()} ${step.name}`,
          stepId: step.id,
          state,
        });
      }
    }
    if (run.completedAt) {
      rows.push({
        at: new Date(run.completedAt).getTime() - originMs,
        label: `Run ${run.status}`,
        state: run.status === 'completed' ? 'completed' : 'failed',
      });
    }
    return rows.sort((a, b) => a.at - b.at);
  }, [run, originMs]);

  if (events.length <= 1) {
    return (
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        No events yet — the first step will appear here as soon as it starts.
      </p>
    );
  }

  return (
    <ol className="space-y-0.5 font-mono text-[11px]">
      {events.map((event, index) => {
        const style = AGENT_STATE[event.state];
        const selected = event.stepId && event.stepId === selectedStepId;
        return (
          <motion.li
            key={`${event.stepId ?? 'run'}-${index}`}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: MOTION.micro, delay: Math.min(index * 0.02, 0.3) }}
          >
            <button
              type="button"
              onClick={() => event.stepId && onSelectStep?.(event.stepId)}
              disabled={!event.stepId}
              className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left transition-colors enabled:hover:bg-[var(--surface-2)] disabled:cursor-default"
              style={{ background: selected ? 'var(--surface-2)' : undefined }}
            >
              <span style={{ color: 'var(--text-muted)' }}>{formatOffset(event.at)}</span>
              <span aria-hidden style={{ color: style.color }}>
                {style.glyph}
              </span>
              <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
                {event.label}
              </span>
            </button>
          </motion.li>
        );
      })}
    </ol>
  );
}

function formatOffset(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
