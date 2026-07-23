'use client';

import { useState } from 'react';
import { formatNumber } from '@/lib/format';

/**
 * The data-flow map: what actually happens to a request, end to end.
 *
 * This answers the question the org chart cannot — *how data is stored,
 * processed and re-used*. Three horizontal lanes:
 *
 *   INGEST   what enters the platform and how it is turned into structure
 *   PROCESS  the agent loop, and the boundary each tool call is checked against
 *   PERSIST  the seven MongoDB collections, and which of them feed back
 *
 * The feedback arrow from `knowledge` back into the agent loop is the whole
 * point of the platform, so it is drawn explicitly rather than implied.
 */

interface Stage {
  id: string;
  label: string;
  detail: string;
  x: number;
  y: number;
  w: number;
  lane: 'ingest' | 'process' | 'persist';
  /** Live counter, when the caller has one. */
  metric?: string;
}

const LANES = [
  { id: 'ingest', label: 'INGEST', y: 30, color: 'var(--series-1)' },
  { id: 'process', label: 'PROCESS', y: 150, color: 'var(--series-6)' },
  { id: 'persist', label: 'PERSIST', y: 300, color: 'var(--series-5)' },
];

export function DataFlowMap({
  counts,
  active,
}: {
  counts?: {
    files?: number;
    knowledge?: number;
    tasks?: number;
    messages?: number;
    decisions?: number;
    runs?: number;
  };
  /** Highlight the stage currently doing work. */
  active?: 'ingest' | 'process' | 'persist' | null;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const stages: Stage[] = [
    { id: 'repo', label: 'Repository', detail: 'Cloned into a per-project workspace. Shallow clone; the GitHub token is used in-memory and never written to .git/config.', x: 20, y: 30, w: 120, lane: 'ingest' },
    { id: 'walk', label: 'Index walk', detail: 'Walks the tree skipping node_modules/dist/.git. Per file: path, size, summary, declared symbols, hash.', x: 160, y: 30, w: 120, lane: 'ingest', metric: counts?.files ? `${formatNumber(counts.files)} files` : undefined },
    { id: 'detect', label: 'Stack detect', detail: 'Three independent signals combined: extension counts → languages, manifest dependencies → frameworks/databases, marker files → deployment & architecture.', x: 300, y: 30, w: 120, lane: 'ingest' },
    { id: 'profile', label: 'Project profile', detail: 'The fingerprint injected into every agent system prompt. This is what makes generated code match your stack.', x: 440, y: 30, w: 130, lane: 'ingest' },

    { id: 'retrieve', label: 'Retrieval', detail: 'Ranks memory + file index against the task. Only the top matches are sent — the repository is NEVER shipped to the model.', x: 20, y: 150, w: 120, lane: 'process' },
    { id: 'prompt', label: 'Prompt build', detail: 'System = agent instructions + profile (cached prefix). User = decisions + memory + file shortlist + inbox + instruction.', x: 160, y: 150, w: 120, lane: 'process' },
    { id: 'model', label: 'Claude', detail: 'Adaptive thinking, per-agent effort. Returns text or tool_use blocks; the runtime loops until the agent reports completion.', x: 300, y: 150, w: 120, lane: 'process' },
    { id: 'guard', label: 'Permission guard', detail: 'EVERY tool call passes here first. Deny wins over allow; absence of a rule means denied. A refused call returns to the model as a recoverable error.', x: 440, y: 150, w: 130, lane: 'process' },
    { id: 'effect', label: 'Effect', detail: 'Sandboxed filesystem write, allowlisted command (no shell), or git operation. Nothing else can reach the disk.', x: 440, y: 210, w: 130, lane: 'process' },

    { id: 'projects', label: 'projects', detail: 'Tenant boundary + detected profile.', x: 20, y: 300, w: 84, lane: 'persist' },
    { id: 'repositories', label: 'repositories', detail: 'VCS state + the file index that powers retrieval.', x: 112, y: 300, w: 92, lane: 'persist' },
    { id: 'tasks', label: 'tasks', detail: 'Units of work with full status history and artifacts.', x: 212, y: 300, w: 76, lane: 'persist', metric: counts?.tasks ? String(counts.tasks) : undefined },
    { id: 'messages', label: 'messages', detail: 'The inter-agent bus. Durable, addressed, auditable.', x: 296, y: 300, w: 84, lane: 'persist', metric: counts?.messages ? String(counts.messages) : undefined },
    { id: 'knowledge', label: 'knowledge', detail: 'Long-term memory. Weighted text index — this is what gets retrieved next run.', x: 388, y: 300, w: 88, lane: 'persist', metric: counts?.knowledge ? String(counts.knowledge) : undefined },
    { id: 'decisions', label: 'decisions', detail: 'ADRs. Injected unconditionally — binding on every future agent.', x: 484, y: 300, w: 86, lane: 'persist', metric: counts?.decisions ? String(counts.decisions) : undefined },
  ];

  const byId = (id: string) => stages.find((s) => s.id === id)!;
  const laneColor = (lane: string) => LANES.find((l) => l.id === lane)!.color;

  const H = 42;
  const cx = (s: Stage) => s.x + s.w / 2;

  return (
    <div>
      <svg viewBox="0 0 600 400" className="w-full" role="img" aria-label="Platform data flow">
        {LANES.map((lane) => (
          <g key={lane.id}>
            <rect
              x="8" y={lane.y - 20} width="584"
              height={lane.id === 'process' ? 122 : lane.id === 'persist' ? 62 : 62}
              rx="8" fill="var(--surface-2)"
              opacity={active && active !== lane.id ? 0.4 : 1}
            />
            <text x="14" y={lane.y - 8} fontSize="8" letterSpacing="1.5" fill={lane.color} fontWeight="700">
              {lane.label}
            </text>
          </g>
        ))}

        <defs>
          <marker id="df-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong)" />
          </marker>
          <marker id="df-arrow-feed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--series-5)" />
          </marker>
        </defs>

        {/* Sequential flow within each lane */}
        {[
          ['repo', 'walk'], ['walk', 'detect'], ['detect', 'profile'],
          ['retrieve', 'prompt'], ['prompt', 'model'], ['model', 'guard'],
        ].map(([from, to]) => {
          const a = byId(from);
          const b = byId(to);
          return (
            <line
              key={`${from}-${to}`}
              x1={a.x + a.w} y1={a.y + H / 2}
              x2={b.x - 4} y2={b.y + H / 2}
              stroke="var(--border-strong)" strokeWidth="1.5" markerEnd="url(#df-arrow)"
              className={active === a.lane ? 'flow-active' : undefined}
            />
          );
        })}

        {/* guard → effect (vertical) */}
        <line
          x1={cx(byId('guard'))} y1={byId('guard').y + H}
          x2={cx(byId('effect'))} y2={byId('effect').y - 4}
          stroke="var(--border-strong)" strokeWidth="1.5" markerEnd="url(#df-arrow)"
        />

        {/* profile → retrieval (ingest feeds process) */}
        <path
          d={`M ${cx(byId('profile'))} ${byId('profile').y + H} L ${cx(byId('profile'))} 118 L 80 118 L 80 ${byId('retrieve').y - 4}`}
          fill="none" stroke="var(--border-strong)" strokeWidth="1.5" markerEnd="url(#df-arrow)"
        />

        {/* process → persist writes */}
        {['tasks', 'messages', 'knowledge', 'decisions'].map((id) => {
          const b = byId(id);
          return (
            <line
              key={`w-${id}`}
              x1={cx(byId('model'))} y1={byId('effect').y + H}
              x2={cx(b)} y2={b.y - 4}
              stroke="var(--border)" strokeWidth="1.2" markerEnd="url(#df-arrow)" opacity="0.75"
            />
          );
        })}

        {/*
          THE feedback loop: stored knowledge is retrieved on the next run.
          Drawn in the persist-lane colour and labelled, because this edge is the
          difference between a chatbot and an organization that learns.
        */}
        <path
          d={`M ${byId('knowledge').x} ${byId('knowledge').y + H / 2} L 6 ${byId('knowledge').y + H / 2} L 6 ${byId('retrieve').y + H / 2} L ${byId('retrieve').x - 4} ${byId('retrieve').y + H / 2}`}
          fill="none" stroke="var(--series-5)" strokeWidth="2"
          markerEnd="url(#df-arrow-feed)" strokeDasharray="5 3"
        />
        <text x="14" y={byId('retrieve').y + H / 2 + 44} fontSize="8.5" fill="var(--series-5)" fontWeight="600">
          memory feeds the next run
        </text>

        {/* Stage boxes */}
        {stages.map((s) => {
          const isHovered = hovered === s.id;
          const color = laneColor(s.lane);
          return (
            <g
              key={s.id}
              onMouseEnter={() => setHovered(s.id)}
              onMouseLeave={() => setHovered(null)}
              className="cursor-help"
            >
              <rect
                x={s.x} y={s.y} width={s.w} height={H} rx="6"
                fill="var(--surface-1)"
                stroke={isHovered ? color : 'var(--border-strong)'}
                strokeWidth={isHovered ? 2 : 1.25}
              />
              <text
                x={cx(s)} y={s.y + (s.metric ? 17 : 25)}
                textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--text-primary)"
              >
                {s.label}
              </text>
              {s.metric && (
                <text x={cx(s)} y={s.y + 31} textAnchor="middle" fontSize="9" fill={color} className="tabular">
                  {s.metric}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="mt-2 min-h-[44px] rounded-lg border bg-[var(--surface-2)] px-3 py-2">
        {hovered ? (
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--text-primary)]">{byId(hovered).label}</span>
            {' — '}
            {byId(hovered).detail}
          </p>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">
            Hover any stage to see what it does. The green dashed edge is the feedback loop:
            everything an agent learns is retrieved by the next one.
          </p>
        )}
      </div>
    </div>
  );
}
