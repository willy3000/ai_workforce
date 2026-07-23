'use client';

import { useState } from 'react';
import type { Task } from '@/lib/types';
import { agentColor, agentShort, statusStyle, TASK_COLUMNS } from '@/lib/design';
import { timeAgo } from '@/lib/format';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { Button, Disclosure, EmptyState, OutputBlock, StatusPill } from '@/components/ui';

/**
 * Kanban view of the task engine.
 *
 * Columns are the real status enum, in lifecycle order. Empty columns are
 * collapsed rather than hidden so the shape of the pipeline stays legible —
 * an empty "Blocked" column is information.
 */
export function TaskBoard({
  tasks,
  onChanged,
}: {
  tasks: Task[];
  onChanged?: () => void;
}) {
  const [selected, setSelected] = useState<Task | null>(null);

  if (!tasks.length) {
    return (
      <EmptyState
        title="No tasks yet"
        hint="Tasks appear here when you commission a workflow or create one directly. Each workflow step also materialises as a task, so everything is inspectable the same way."
      />
    );
  }

  const columns = TASK_COLUMNS.map((col) => ({
    ...col,
    tasks: tasks.filter((t) => t.status === col.status),
  })).filter((col) => col.tasks.length > 0 || ['in_progress', 'done', 'blocked'].includes(col.status));

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((col) => {
          const s = statusStyle(col.status);
          return (
            <div key={col.status} className="w-60 shrink-0">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <span aria-hidden style={{ color: s.color }}>{s.glyph}</span>
                  {col.label}
                </span>
                <span className="tabular rounded-full bg-[var(--surface-2)] px-1.5 text-[10px] text-[var(--text-muted)]">
                  {col.tasks.length}
                </span>
              </div>
              <div className="space-y-2">
                {col.tasks.map((task) => (
                  <button
                    key={task._id}
                    onClick={() => setSelected(task)}
                    className="w-full rounded-lg border bg-[var(--surface-1)] p-2.5 text-left transition-colors hover:border-[var(--border-strong)]"
                  >
                    <p className="line-clamp-2 text-xs font-medium leading-snug">{task.title}</p>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      {task.assignedTo ? (
                        <span
                          className="flex items-center gap-1 text-[10px] font-bold"
                          style={{ color: agentColor(task.assignedTo) }}
                          title={task.assignedTo}
                        >
                          <span
                            aria-hidden
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ background: agentColor(task.assignedTo) }}
                          />
                          {agentShort(task.assignedTo)}
                        </span>
                      ) : (
                        <span className="text-[10px] text-[var(--text-muted)]">unassigned</span>
                      )}
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {timeAgo(task.createdAt)}
                      </span>
                    </div>
                    {task.artifacts.length > 0 && (
                      <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                        {task.artifacts.length} artifact{task.artifacts.length === 1 ? '' : 's'}
                      </p>
                    )}
                  </button>
                ))}
                {!col.tasks.length && (
                  <p className="rounded-lg border border-dashed px-2 py-3 text-center text-[10px] text-[var(--text-muted)]">
                    empty
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <TaskDrawer
          task={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setSelected(null);
            onChanged?.();
          }}
        />
      )}
    </>
  );
}

function TaskDrawer({
  task,
  onClose,
  onChanged,
}: {
  task: Task;
  onClose: () => void;
  onChanged: () => void;
}) {
  const run = useAction(api.runTask);
  const approve = useAction(api.approveTask);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-xl overflow-y-auto border-l bg-[var(--surface-1)] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-snug">{task.title}</h3>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <StatusPill status={task.status} size="xs" />
              {task.assignedTo && (
                <span
                  className="rounded-md border px-1.5 py-0.5 text-[10px]"
                  style={{ borderColor: agentColor(task.assignedTo), color: agentColor(task.assignedTo) }}
                >
                  {task.assignedTo}
                </span>
              )}
              <span className="text-[10px] text-[var(--text-muted)]">
                {task.type} · {task.priority} priority · attempt {task.attempts}
              </span>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>✕</Button>
        </div>

        <div className="flex gap-2">
          {['backlog', 'ready', 'failed'].includes(task.status) && (
            <Button
              size="sm"
              variant="primary"
              disabled={run.pending}
              onClick={async () => {
                await run.execute(task._id);
                onChanged();
              }}
            >
              {run.pending ? 'Running…' : 'Run this task'}
            </Button>
          )}
          {task.status === 'awaiting_approval' && (
            <Button
              size="sm"
              variant="primary"
              disabled={approve.pending}
              onClick={async () => {
                await approve.execute(task._id);
                onChanged();
              }}
            >
              Approve
            </Button>
          )}
        </div>

        {(run.error || approve.error) && (
          <p className="mt-2 text-xs" style={{ color: 'var(--status-critical)' }}>
            {run.error ?? approve.error}
          </p>
        )}

        <Section title="Description">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">
            {task.description || '—'}
          </p>
        </Section>

        {task.acceptanceCriteria.length > 0 && (
          <Section title="Acceptance criteria">
            <ul className="space-y-1">
              {task.acceptanceCriteria.map((c, i) => (
                <li key={i} className="flex gap-2 text-xs text-[var(--text-secondary)]">
                  <span aria-hidden className="text-[var(--text-muted)]">□</span>
                  {c}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {task.result && (
          <Section title="Agent result">
            <OutputBlock text={task.result} maxHeight={280} />
          </Section>
        )}

        {task.artifacts.length > 0 && (
          <Section title={`Artifacts (${task.artifacts.length})`}>
            <div className="space-y-1.5">
              {task.artifacts.map((a, i) => (
                <Disclosure
                  key={i}
                  summary={
                    <span>
                      <span className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono text-[10px]">
                        {a.type}
                      </span>{' '}
                      {a.path ?? ''}
                    </span>
                  }
                >
                  <OutputBlock text={a.content} maxHeight={200} />
                </Disclosure>
              ))}
            </div>
          </Section>
        )}

        <Section title="History">
          <ol className="space-y-1.5">
            {task.history.map((h, i) => (
              <li key={i} className="flex gap-2 text-[11px]">
                <span className="shrink-0 text-[var(--text-muted)]">{timeAgo(h.at)}</span>
                <span className="text-[var(--text-secondary)]">
                  <span className="font-medium">{h.actor}</span>
                  {h.from && h.to && ` · ${h.from} → ${h.to}`}
                  {h.note && ` — ${h.note}`}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t pt-3">
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {title}
      </p>
      {children}
    </div>
  );
}
