'use client';

import { useState } from 'react';
import type { WorkflowRun, WorkflowStepState } from '@/lib/types';
import { agentColor, agentShort, statusStyle } from '@/lib/design';
import { duration, formatNumber, estimateCost } from '@/lib/format';
import { Button, Disclosure, OutputBlock, StatusPill } from '@/components/ui';

/**
 * A live workflow run, step by step.
 *
 * The layout is a vertical timeline rather than a horizontal pipeline because
 * step output is the payload people actually want to read, and reading long
 * prose in a horizontal strip is miserable. Each step carries its own token
 * usage, so cost is attributable per agent rather than only in aggregate.
 */
export function WorkflowPipeline({
  run,
  onApprove,
  onResume,
  busy,
}: {
  run: WorkflowRun;
  onApprove?: (stepId: string) => void;
  onResume?: () => void;
  busy?: boolean;
}) {
  const totals = run.steps.reduce(
    (acc, s) => ({
      input: acc.input + (s.usage?.inputTokens ?? 0),
      output: acc.output + (s.usage?.outputTokens ?? 0),
      tools: acc.tools + (s.usage?.toolCalls ?? 0),
    }),
    { input: 0, output: 0, tools: 0 },
  );

  const completed = run.steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length;
  const progress = run.steps.length ? completed / run.steps.length : 0;

  return (
    <div>
      {/* Progress bar: 4px rounded end, anchored to a baseline, no gradient. */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="text-[var(--text-secondary)]">
            {completed} of {run.steps.length} steps
          </span>
          <span className="tabular text-[var(--text-muted)]">
            {formatNumber(totals.input)} in · {formatNumber(totals.output)} out ·{' '}
            {totals.tools} tool calls · {estimateCost(totals.input, totals.output)} est.
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${Math.max(progress * 100, 2)}%`,
              background:
                run.status === 'failed'
                  ? 'var(--status-critical)'
                  : run.status === 'completed'
                    ? 'var(--status-good)'
                    : 'var(--series-1)',
            }}
          />
        </div>
      </div>

      <ol className="relative">
        {run.steps.map((step, i) => (
          <StepRow
            key={step.id}
            step={step}
            index={i}
            isLast={i === run.steps.length - 1}
            onApprove={onApprove}
            busy={busy}
          />
        ))}
      </ol>

      {run.status === 'awaiting_approval' && onResume && (
        <div
          className="mt-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
          style={{ borderColor: 'var(--status-warning)' }}
        >
          <p className="text-xs" style={{ color: 'var(--status-warning)' }}>
            ⏸ This run is paused at an approval gate. Nothing will touch the repository until you approve.
          </p>
          <Button size="sm" onClick={onResume} disabled={busy}>
            Resume
          </Button>
        </div>
      )}

      {run.error && (
        <div
          className="mt-3 rounded-lg border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--status-critical)', color: 'var(--status-critical)' }}
        >
          {run.error}
        </div>
      )}
    </div>
  );
}

function StepRow({
  step,
  index,
  isLast,
  onApprove,
  busy,
}: {
  step: WorkflowStepState;
  index: number;
  isLast: boolean;
  onApprove?: (stepId: string) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const s = statusStyle(step.status);
  const color = agentColor(step.agentKey);
  const running = step.status === 'running';

  return (
    <li className="relative flex gap-3 pb-3">
      {/* Rail */}
      {!isLast && (
        <div
          className="absolute left-[15px] top-8 bottom-0 w-px"
          style={{ background: 'var(--border)' }}
          aria-hidden
        />
      )}

      {/* Agent node */}
      <div className="relative z-10 shrink-0">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full border-2 bg-[var(--surface-1)] text-[10px] font-bold"
          style={{
            borderColor: color,
            color,
            opacity: step.status === 'skipped' || step.status === 'pending' ? 0.45 : 1,
          }}
          title={step.agentKey}
        >
          {agentShort(step.agentKey)}
        </div>
        {running && (
          <span
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-[var(--surface-1)]"
            style={{ background: 'var(--series-1)' }}
            aria-hidden
          />
        )}
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1 rounded-lg border bg-[var(--surface-1)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              <span className="tabular mr-1.5 text-[var(--text-muted)]">{index + 1}.</span>
              {step.name}
            </p>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
              {step.agentKey}
              {step.startedAt && ` · ${duration(step.startedAt, step.completedAt)}`}
              {step.usage && step.usage.toolCalls > 0 && ` · ${step.usage.toolCalls} tool calls`}
              {step.usage && step.usage.outputTokens > 0 &&
                ` · ${formatNumber(step.usage.inputTokens)}/${formatNumber(step.usage.outputTokens)} tok`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusPill status={step.status} size="xs" />
            {step.status === 'awaiting_approval' && onApprove && (
              <Button size="sm" variant="primary" onClick={() => onApprove(step.id)} disabled={busy}>
                Approve
              </Button>
            )}
          </div>
        </div>

        {step.error && (
          <p className="mt-2 text-[11px]" style={{ color: 'var(--status-critical)' }}>
            {step.error}
          </p>
        )}

        {step.output && (
          <div className="mt-2">
            <button
              onClick={() => setOpen((o) => !o)}
              className="text-[11px] text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)]"
            >
              {open ? 'Hide' : 'Show'} agent output ({formatNumber(step.output.length)} chars)
            </button>
            {open && (
              <div className="mt-2">
                <OutputBlock text={step.output} maxHeight={420} />
              </div>
            )}
            {!open && (
              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
                {step.output.slice(0, 220)}
                {step.output.length > 220 ? '…' : ''}
              </p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** Compact horizontal version for cards and list rows. */
export function PipelineStrip({ run }: { run: WorkflowRun }) {
  return (
    <div className="flex items-center gap-1" title={`${run.workflow}: ${run.status}`}>
      {run.steps.map((step) => {
        const s = statusStyle(step.status);
        return (
          <span
            key={step.id}
            title={`${step.name} — ${s.label}`}
            className="h-1.5 flex-1 rounded-full"
            style={{
              background:
                step.status === 'pending'
                  ? 'var(--surface-2)'
                  : step.status === 'skipped'
                    ? 'var(--border-strong)'
                    : s.color,
              opacity: step.status === 'pending' ? 1 : 0.9,
            }}
          />
        );
      })}
    </div>
  );
}
