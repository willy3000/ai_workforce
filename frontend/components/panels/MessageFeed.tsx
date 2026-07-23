'use client';

import { useState } from 'react';
import type { AgentMessage } from '@/lib/types';
import { agentColor, agentShort } from '@/lib/design';
import { timeAgo } from '@/lib/format';
import { EmptyState } from '@/components/ui';

/**
 * The inter-agent message bus, as a live feed.
 *
 * This is the closest thing the platform has to "watching your team talk". The
 * intent is rendered as a labelled chip because the *kind* of message
 * (escalation vs. status) is what a human scanning the feed needs first — an
 * escalation addressed to you is the one thing here that requires action.
 */

const INTENT_STYLE: Record<string, { color: string; glyph: string }> = {
  escalation: { color: 'var(--status-critical)', glyph: '⚑' },
  clarification: { color: 'var(--status-warning)', glyph: '?' },
  question: { color: 'var(--status-warning)', glyph: '?' },
  review_request: { color: 'var(--series-5)', glyph: '⌕' },
  review_result: { color: 'var(--series-5)', glyph: '✓' },
  handoff: { color: 'var(--series-1)', glyph: '⇄' },
  completion: { color: 'var(--status-good)', glyph: '✓' },
  instruction: { color: 'var(--series-1)', glyph: '→' },
  status: { color: 'var(--text-muted)', glyph: '·' },
};

export function MessageFeed({
  messages,
  limit = 40,
}: {
  messages: AgentMessage[];
  limit?: number;
}) {
  const [filter, setFilter] = useState<string>('all');

  const intents = ['all', ...new Set(messages.map((m) => m.intent))];
  const visible = (filter === 'all' ? messages : messages.filter((m) => m.intent === filter)).slice(
    0,
    limit,
  );

  if (!messages.length) {
    return (
      <EmptyState
        title="No agent messages yet"
        hint="When agents ask each other for clarification, hand off work, or escalate a decision to you, it appears here — persisted, addressed and auditable."
      />
    );
  }

  return (
    <div>
      {intents.length > 2 && (
        <div className="mb-2.5 flex flex-wrap gap-1">
          {intents.map((intent) => (
            <button
              key={intent}
              onClick={() => setFilter(intent)}
              className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                filter === intent
                  ? 'border-[var(--series-1)] text-[var(--series-1)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {intent.replace(/_/g, ' ')}
              {intent !== 'all' && (
                <span className="tabular ml-1 opacity-60">
                  {messages.filter((m) => m.intent === intent).length}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <ul className="space-y-2">
        {visible.map((m) => {
          const style = INTENT_STYLE[m.intent] ?? INTENT_STYLE.status!;
          const toHuman = m.to === 'human';
          return (
            <li
              key={m._id}
              className="rounded-lg border bg-[var(--surface-1)] p-2.5"
              style={toHuman ? { borderColor: style.color } : undefined}
            >
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span
                  className="font-bold"
                  style={{ color: agentColor(m.from) }}
                  title={m.from}
                >
                  {agentShort(m.from)}
                </span>
                <span aria-hidden className="text-[var(--text-muted)]">→</span>
                <span
                  className="font-bold"
                  style={{ color: agentColor(m.to) }}
                  title={m.to}
                >
                  {agentShort(m.to)}
                </span>
                <span
                  className="ml-1 flex items-center gap-1 rounded border px-1 text-[10px]"
                  style={{ color: style.color, borderColor: style.color }}
                >
                  <span aria-hidden>{style.glyph}</span>
                  {m.intent.replace(/_/g, ' ')}
                </span>
                <span className="ml-auto text-[10px] text-[var(--text-muted)]">
                  {timeAgo(m.createdAt)}
                </span>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">
                {m.message.length > 600 ? `${m.message.slice(0, 600)}…` : m.message}
              </p>
            </li>
          );
        })}
      </ul>

      {messages.length > visible.length && (
        <p className="mt-2 text-center text-[10px] text-[var(--text-muted)]">
          Showing {visible.length} of {messages.length}
        </p>
      )}
    </div>
  );
}
