'use client';

import { useMemo, useState } from 'react';
import type { MemorySnapshot } from '@/lib/types';
import { KNOWLEDGE_COLOR } from '@/lib/design';
import { timeAgo } from '@/lib/format';
import { Badge, EmptyState, TextInput } from '@/components/ui';

/**
 * Browse what the organization has learned about a codebase.
 *
 * This is the panel that makes "long-term memory" concrete rather than a claim:
 * every entry here was written either by onboarding or by an agent during a run,
 * and every entry here is retrievable into a future agent's context.
 *
 * Decisions are listed separately and first because they behave differently —
 * they are injected unconditionally, so they bind every future agent whether or
 * not they match the task's keywords.
 */
export function MemoryExplorer({ memory }: { memory: MemorySnapshot }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<string>('all');

  const kinds = useMemo(
    () => ['all', ...Object.keys(memory.counts.knowledge ?? {}).sort()],
    [memory],
  );

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return memory.knowledge.filter((k) => {
      if (kind !== 'all' && k.kind !== kind) return false;
      if (!q) return true;
      return (
        k.title.toLowerCase().includes(q) ||
        k.content.toLowerCase().includes(q) ||
        k.tags.some((t) => t.toLowerCase().includes(q)) ||
        k.paths.some((p) => p.toLowerCase().includes(q))
      );
    });
  }, [memory.knowledge, query, kind]);

  const totalKnowledge = memory.knowledge.length;

  if (!totalKnowledge && !memory.decisions.length) {
    return (
      <EmptyState
        title="Memory is empty"
        hint="Connect a repository — onboarding seeds the stack, conventions, build commands and key files. Agents extend it as they work."
      />
    );
  }

  return (
    <div>
      {memory.decisions.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 flex items-center gap-2 text-xs font-medium">
            Architecture decisions
            <span className="rounded-full bg-[var(--surface-2)] px-1.5 text-[10px] text-[var(--text-muted)]">
              {memory.decisions.length}
            </span>
            <span className="text-[10px] font-normal text-[var(--text-muted)]">
              binding on every future agent
            </span>
          </p>
          <div className="space-y-2">
            {memory.decisions.map((d) => (
              <div
                key={d.id}
                className="rounded-lg border-l-2 bg-[var(--surface-1)] p-2.5"
                style={{ borderLeftColor: 'var(--series-1)' }}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-medium">{d.title}</p>
                  <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                    {d.decidedBy} · {timeAgo(d.createdAt)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {d.decision}
                </p>
                {d.rationale && (
                  <p className="mt-1 text-[11px] italic leading-relaxed text-[var(--text-muted)]">
                    Why: {d.rationale}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <div className="min-w-[180px] flex-1">
          <TextInput
            placeholder="Search memory…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {kinds.map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                kind === k ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
              }`}
              style={
                kind === k
                  ? { borderColor: k === 'all' ? 'var(--series-1)' : KNOWLEDGE_COLOR[k] }
                  : undefined
              }
            >
              {k.replace(/_/g, ' ')}
              {k !== 'all' && (
                <span className="tabular ml-1 opacity-60">{memory.counts.knowledge[k]}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {!filtered.length ? (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-[var(--text-muted)]">
          Nothing in memory matches “{query}”.
        </p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((k) => (
            <li key={k.id} className="rounded-lg border bg-[var(--surface-1)] p-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-xs font-medium">{k.title}</p>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge color={KNOWLEDGE_COLOR[k.kind]}>{k.kind.replace(/_/g, ' ')}</Badge>
                  <span className="text-[10px] text-[var(--text-muted)]">{timeAgo(k.updatedAt)}</span>
                </div>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-secondary)]">
                {k.content.length > 400 ? `${k.content.slice(0, 400)}…` : k.content}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
                <span>via {k.source}</span>
                {k.paths.slice(0, 3).map((p) => (
                  <code key={p} className="rounded bg-[var(--surface-2)] px-1 font-mono">
                    {p}
                  </code>
                ))}
                {k.tags.slice(0, 4).map((t) => (
                  <span key={t}>#{t}</span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 border-t pt-2 text-[10px] text-[var(--text-muted)]">
        Showing {filtered.length} of {totalKnowledge} entries. Agents retrieve the most relevant of
        these per task — the whole store is never sent to the model.
      </p>
    </div>
  );
}
