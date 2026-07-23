'use client';

import { useState } from 'react';
import type { Agent } from '@/lib/types';
import { agentColor, agentShort } from '@/lib/design';
import { formatNumber } from '@/lib/format';

/**
 * The organization chart.
 *
 * Form choice: this is a *relationship* question ("who hands work to whom, and
 * who is allowed to touch what"), not a magnitude question — so it is a node-link
 * diagram, not a chart. Layout is hand-placed rather than force-directed on
 * purpose: the org has a fixed hierarchy, and a force layout would rearrange it
 * on every render, destroying the reader's spatial memory of where QA lives.
 *
 * Interaction: hovering a node dims everything it does not touch, so the
 * question "what does the frontend engineer actually connect to?" is answered
 * by pointing at it.
 */

interface NodePos {
  key: string;
  x: number;
  y: number;
  tier: string;
}

const LAYOUT: NodePos[] = [
  { key: 'human', x: 300, y: 34, tier: 'Request' },
  { key: 'project-manager', x: 300, y: 118, tier: 'Planning' },
  { key: 'engineering-manager', x: 300, y: 202, tier: 'Architecture' },
  { key: 'backend-engineer', x: 148, y: 300, tier: 'Implementation' },
  { key: 'frontend-engineer', x: 452, y: 300, tier: 'Implementation' },
  { key: 'qa-engineer', x: 300, y: 388, tier: 'Verification' },
  { key: 'documentation-engineer', x: 300, y: 466, tier: 'Record' },
];

/** Directed edges = the actual handoff paths in the feature-development workflow. */
const EDGES: { from: string; to: string; label?: string }[] = [
  { from: 'human', to: 'project-manager', label: 'request' },
  { from: 'project-manager', to: 'engineering-manager', label: 'plan' },
  { from: 'engineering-manager', to: 'backend-engineer', label: 'contract' },
  { from: 'engineering-manager', to: 'frontend-engineer', label: 'contract' },
  { from: 'backend-engineer', to: 'qa-engineer' },
  { from: 'frontend-engineer', to: 'qa-engineer' },
  { from: 'qa-engineer', to: 'documentation-engineer' },
];

/** Lateral peer-to-peer messages (the message bus), drawn dashed to distinguish. */
const PEER_EDGES: { from: string; to: string }[] = [
  { from: 'frontend-engineer', to: 'backend-engineer' },
  { from: 'qa-engineer', to: 'backend-engineer' },
  { from: 'qa-engineer', to: 'frontend-engineer' },
];

const NODE_R = 30;

export function AgentNetwork({
  agents,
  activeAgents = [],
  onSelect,
  selected,
}: {
  agents: Agent[];
  /** Agent keys currently executing — drives the pulse + animated edges. */
  activeAgents?: string[];
  onSelect?: (key: string) => void;
  selected?: string | null;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const byKey = new Map(agents.map((a) => [a.key, a]));
  const focus = hovered ?? selected ?? null;

  const pos = (key: string) => LAYOUT.find((n) => n.key === key)!;

  const connected = (key: string): Set<string> => {
    const set = new Set<string>([key]);
    for (const e of [...EDGES, ...PEER_EDGES]) {
      if (e.from === key) set.add(e.to);
      if (e.to === key) set.add(e.from);
    }
    return set;
  };
  const lit = focus ? connected(focus) : null;
  const dim = (key: string) => (lit && !lit.has(key) ? 0.18 : 1);

  return (
    <div className="relative">
      <svg viewBox="0 0 600 510" className="w-full" role="img" aria-label="Agent organization chart">
        {/* Tier bands: give the hierarchy a readable spine without a heavy grid. */}
        {['Planning', 'Architecture', 'Implementation', 'Verification', 'Record'].map((tier) => {
          const node = LAYOUT.find((n) => n.tier === tier)!;
          return (
            <g key={tier}>
              <line
                x1="18" x2="582" y1={node.y} y2={node.y}
                stroke="var(--grid)" strokeWidth="1"
              />
              <text x="18" y={node.y - 8} fontSize="9" fill="var(--text-muted)" letterSpacing="1">
                {tier.toUpperCase()}
              </text>
            </g>
          );
        })}

        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong)" />
          </marker>
          <marker id="arrow-lit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--series-1)" />
          </marker>
        </defs>

        {/* Peer messaging (dashed = asynchronous message bus, not a workflow handoff) */}
        {PEER_EDGES.map((e) => {
          const a = pos(e.from);
          const b = pos(e.to);
          const isLit = lit ? lit.has(e.from) && lit.has(e.to) : false;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2 + 46;
          return (
            <path
              key={`${e.from}-${e.to}-peer`}
              d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
              fill="none"
              stroke="var(--border-strong)"
              strokeWidth="1.5"
              strokeDasharray="3 4"
              opacity={lit ? (isLit ? 0.9 : 0.08) : 0.4}
            />
          );
        })}

        {/* Workflow handoffs */}
        {EDGES.map((e) => {
          const a = pos(e.from);
          const b = pos(e.to);
          const isLit = lit ? lit.has(e.from) && lit.has(e.to) : false;
          const flowing = activeAgents.includes(e.to);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          const ux = dx / len;
          const uy = dy / len;
          const x1 = a.x + ux * NODE_R;
          const y1 = a.y + uy * NODE_R;
          const x2 = b.x - ux * (NODE_R + 7);
          const y2 = b.y - uy * (NODE_R + 7);

          return (
            <g key={`${e.from}-${e.to}`} opacity={lit ? (isLit ? 1 : 0.1) : 1}>
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={flowing ? 'var(--series-1)' : isLit ? 'var(--series-1)' : 'var(--border-strong)'}
                strokeWidth="2"
                markerEnd={isLit || flowing ? 'url(#arrow-lit)' : 'url(#arrow)'}
                className={flowing ? 'flow-active' : undefined}
              />
              {e.label && (
                <text
                  x={(x1 + x2) / 2 + (dx === 0 ? 8 : 0)}
                  y={(y1 + y2) / 2 - 4}
                  fontSize="9"
                  fill="var(--text-muted)"
                  textAnchor={dx === 0 ? 'start' : 'middle'}
                >
                  {e.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Nodes */}
        {LAYOUT.map((n) => {
          const agent = byKey.get(n.key);
          const color = agentColor(n.key);
          const isHuman = n.key === 'human';
          const active = activeAgents.includes(n.key);
          const isSelected = selected === n.key;

          return (
            <g
              key={n.key}
              opacity={dim(n.key)}
              className={onSelect && !isHuman ? 'cursor-pointer' : undefined}
              onMouseEnter={() => setHovered(n.key)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => !isHuman && onSelect?.(n.key)}
            >
              {active && (
                <circle cx={n.x} cy={n.y} r={NODE_R} fill={color} className="pulse-ring" />
              )}
              <circle
                cx={n.x} cy={n.y} r={NODE_R}
                fill="var(--surface-1)"
                stroke={color}
                strokeWidth={isSelected ? 4 : active ? 3 : 2}
                strokeDasharray={isHuman ? '4 3' : undefined}
              />
              <text
                x={n.x} y={n.y + 1}
                textAnchor="middle" dominantBaseline="middle"
                fontSize="13" fontWeight="700" fill={color}
              >
                {agentShort(n.key)}
              </text>
              <text
                x={n.x} y={n.y + NODE_R + 14}
                textAnchor="middle" fontSize="10.5" fill="var(--text-primary)" fontWeight="500"
              >
                {isHuman ? 'You' : (agent?.name ?? n.key)}
              </text>
              {agent && (
                <text
                  x={n.x} y={n.y + NODE_R + 26}
                  textAnchor="middle" fontSize="9" fill="var(--text-muted)"
                >
                  {agent.permissions.canWrite
                    ? `writes ${agent.permissions.writePaths.length} scopes`
                    : 'read-only'}
                  {agent.stats.runs > 0 ? ` · ${formatNumber(agent.stats.runs)} runs` : ''}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 text-[10px] text-[var(--text-muted)]">
        <span className="flex items-center gap-1.5">
          <svg width="20" height="6" aria-hidden>
            <line x1="0" y1="3" x2="20" y2="3" stroke="var(--border-strong)" strokeWidth="2" />
          </svg>
          workflow handoff
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="20" height="6" aria-hidden>
            <line x1="0" y1="3" x2="20" y2="3" stroke="var(--border-strong)" strokeWidth="1.5" strokeDasharray="3 4" />
          </svg>
          message bus (async)
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="20" height="6" aria-hidden>
            <line x1="0" y1="3" x2="20" y2="3" stroke="var(--series-1)" strokeWidth="2" className="flow-active" />
          </svg>
          data flowing now
        </span>
        <span>Hover a role to isolate its connections · click for detail</span>
      </div>
    </div>
  );
}
