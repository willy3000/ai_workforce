'use client';

import { useState } from 'react';
import type { Agent } from '@/lib/types';
import { agentColor } from '@/lib/design';
import { estimateCost, formatNumber } from '@/lib/format';
import { EmptyState } from '@/components/ui';

/**
 * Token usage per agent.
 *
 * Form: horizontal bars — the category labels are long role names, and
 * horizontal bars let them be read as text rather than rotated 45°. One measure
 * per chart (never a dual axis): tokens here, tool calls in its own chart.
 *
 * Marks follow the spec: thin bars, 4px rounded data-end anchored to a common
 * baseline, a 2px surface gap between the stacked input/output segments, and
 * direct labels rather than a value on every tick.
 */
export function UsageChart({ agents }: { agents: Agent[] }) {
  const [hovered, setHovered] = useState<string | null>(null);

  const rows = agents
    .map((a) => ({
      key: a.key,
      name: a.name,
      input: a.stats.inputTokens,
      output: a.stats.outputTokens,
      total: a.stats.inputTokens + a.stats.outputTokens,
      runs: a.stats.runs,
      toolCalls: a.stats.toolCalls,
    }))
    .sort((a, b) => b.total - a.total);

  const max = Math.max(...rows.map((r) => r.total), 1);
  const anyUsage = rows.some((r) => r.total > 0);

  if (!anyUsage) {
    return (
      <EmptyState
        title="No agent runs yet"
        hint="Token usage appears here once an agent has executed. Start a workflow or run a single agent to populate it."
      />
    );
  }

  return (
    <div>
      <div className="space-y-2.5">
        {rows.map((r) => {
          const pct = (r.total / max) * 100;
          const inputPct = r.total ? (r.input / r.total) * 100 : 0;
          const isHovered = hovered === r.key;

          return (
            <div
              key={r.key}
              onMouseEnter={() => setHovered(r.key)}
              onMouseLeave={() => setHovered(null)}
              className="cursor-default"
            >
              <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: agentColor(r.key) }}
                  />
                  <span className="truncate text-[var(--text-secondary)]">{r.name}</span>
                </span>
                {/* Direct label — no axis ticks needed for 6 rows. */}
                <span className="tabular shrink-0 text-[var(--text-muted)]">
                  {formatNumber(r.total)} tok · {estimateCost(r.input, r.output)} est.
                </span>
              </div>

              <div className="flex h-2.5 w-full items-stretch">
                <div
                  className="flex transition-all duration-300"
                  style={{ width: `${Math.max(pct, 0.5)}%` }}
                >
                  {/* input segment */}
                  <div
                    className="rounded-l-[4px]"
                    style={{
                      width: `${inputPct}%`,
                      background: agentColor(r.key),
                      opacity: isHovered ? 1 : 0.55,
                    }}
                  />
                  {/* 2px surface gap between stacked segments */}
                  <div className="w-[2px] shrink-0 bg-[var(--surface-1)]" />
                  {/* output segment */}
                  <div
                    className="flex-1 rounded-r-[4px]"
                    style={{ background: agentColor(r.key), opacity: isHovered ? 1 : 0.85 }}
                  />
                </div>
              </div>

              {isHovered && (
                <p className="tabular mt-1 text-[10px] text-[var(--text-muted)]">
                  {formatNumber(r.input)} input · {formatNumber(r.output)} output ·{' '}
                  {r.runs} runs · {r.toolCalls} tool calls
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-4 border-t pt-2 text-[10px] text-[var(--text-muted)]">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm bg-[var(--text-muted)] opacity-55" aria-hidden />
          input tokens
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm bg-[var(--text-muted)] opacity-85" aria-hidden />
          output tokens
        </span>
        <span>Cost is an estimate at Opus 4.8 list pricing, not a bill.</span>
      </div>
    </div>
  );
}

/** Task-status distribution. Small ordinal bar set with direct labels. */
export function StatusBreakdown({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, v]) => v > 0);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (!total) return null;

  const COLORS: Record<string, string> = {
    done: 'var(--status-good)',
    in_progress: 'var(--series-1)',
    ready: 'var(--series-1)',
    backlog: 'var(--text-muted)',
    awaiting_approval: 'var(--status-warning)',
    awaiting_review: 'var(--status-warning)',
    blocked: 'var(--status-serious)',
    failed: 'var(--status-critical)',
    cancelled: 'var(--text-muted)',
  };

  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full">
        {entries.map(([status, count], i) => (
          <div
            key={status}
            title={`${status}: ${count}`}
            style={{
              width: `${(count / total) * 100}%`,
              background: COLORS[status] ?? 'var(--text-muted)',
              marginLeft: i === 0 ? 0 : 2,
            }}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--text-muted)]">
        {entries.map(([status, count]) => (
          <span key={status} className="flex items-center gap-1">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ background: COLORS[status] ?? 'var(--text-muted)' }}
            />
            <span className="tabular">{count}</span> {status.replace(/_/g, ' ')}
          </span>
        ))}
      </div>
    </div>
  );
}
