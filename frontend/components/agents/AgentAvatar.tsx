'use client';

import { memo } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { AGENT_STATE, agentIdentity, type AgentState, type AgentSilhouette } from '@/lib/agent-visuals';

/**
 * An agent, drawn as an actor rather than a row.
 *
 * Three things make a role recognisable at a glance, and all three are used
 * because any one of them alone excludes somebody:
 *
 *  - **Silhouette.** Each role has its own geometry, so the roster is readable
 *    in greyscale, at 28px, and by someone who cannot distinguish the hues.
 *  - **Colour.** A fixed categorical slot per role, never derived from array
 *    position, so identity survives filtering and sorting.
 *  - **Monogram.** The literal answer when the drawing is too small to read.
 *
 * State is layered on top as a ring, a glyph badge and an ambient motion, so a
 * running agent is distinguishable from an idle one without reading any text.
 *
 * ## Motion
 * Every animation here is ambient and state-derived — nothing moves to be
 * decorative. Under `prefers-reduced-motion` all of it stops and the state is
 * carried entirely by the static ring, glyph and label, which is why those exist
 * rather than relying on the animation to communicate.
 */

export interface AgentAvatarProps {
  agentKey: string;
  state?: AgentState;
  size?: number;
  /** 0–1. Draws a progress arc around the avatar when supplied. */
  progress?: number;
  /** Dim to recede into the background when another node has focus. */
  dimmed?: boolean;
  /** Emphasise as the current focus of the canvas. */
  focused?: boolean;
  showMonogram?: boolean;
}

export const AgentAvatar = memo(function AgentAvatar({
  agentKey,
  state = 'idle',
  size = 64,
  progress,
  dimmed = false,
  focused = false,
  showMonogram = true,
}: AgentAvatarProps) {
  const reduceMotion = useReducedMotion();
  const identity = agentIdentity(agentKey);
  const style = AGENT_STATE[state];

  const center = size / 2;
  const ringRadius = center - 3;
  const bodyScale = size / 64;

  // Ambient motion per state. `work` is a steady pulse that reads as effort;
  // `wait` is slower and shallower, so waiting looks patient rather than busy;
  // `alert` is a single held emphasis, never a flashing loop.
  const ambient = reduceMotion || style.motion === 'none'
    ? {}
    : {
        breathe: { scale: [1, 1.015, 1], opacity: [0.75, 0.85, 0.75] },
        work: { scale: [1, 1.05, 1] },
        wait: { opacity: [0.55, 0.8, 0.55] },
        alert: { scale: [1, 1.03, 1] },
      }[style.motion];

  const ambientDuration = { breathe: 4.5, work: 1.8, wait: 3, alert: 2.4 }[
    style.motion as 'breathe' | 'work' | 'wait' | 'alert'
  ] ?? 4;

  const circumference = 2 * Math.PI * ringRadius;

  return (
    <motion.span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, opacity: dimmed ? 0.34 : 1 }}
      animate={{ opacity: dimmed ? 0.34 : 1, scale: focused ? 1.06 : 1 }}
      transition={{ duration: 0.22 }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${identity.role} — ${style.label}`}
        className="overflow-visible"
      >
        {/* The station plate the agent sits on. Gives every avatar a body
            against the floor, so a node reads as an object in the room rather
            than a floating icon. */}
        <circle
          cx={center}
          cy={center}
          r={ringRadius - 1}
          fill="var(--surface-1)"
          opacity={0.92}
        />

        {/* State ring: the always-present, non-animated carrier of state. */}
        <circle
          cx={center}
          cy={center}
          r={ringRadius}
          fill="none"
          stroke={style.color}
          strokeWidth={state === 'idle' ? 1.25 : 2}
          opacity={style.intensity === 0 ? 0.6 : style.intensity === 1 ? 0.8 : 1}
          strokeDasharray={state === 'queued' || state === 'waiting' ? '3 4' : undefined}
        />

        {/* Progress arc, only when a real fraction is known. */}
        {progress !== undefined && (
          <circle
            cx={center}
            cy={center}
            r={ringRadius}
            fill="none"
            stroke={style.color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, progress)))}
            transform={`rotate(-90 ${center} ${center})`}
            opacity={0.95}
          />
        )}

        {/* Active halo — reserved for states that should command attention. */}
        {style.intensity === 2 && !reduceMotion && (
          <motion.circle
            cx={center}
            cy={center}
            r={ringRadius}
            fill="none"
            stroke={style.color}
            strokeWidth={1}
            initial={{ scale: 1, opacity: 0.5 }}
            animate={{ scale: [1, 1.22], opacity: [0.45, 0] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
            style={{ transformOrigin: `${center}px ${center}px` }}
          />
        )}

        <motion.g
          animate={ambient}
          transition={
            ambient && Object.keys(ambient).length
              ? { duration: ambientDuration, repeat: Infinity, ease: 'easeInOut' }
              : undefined
          }
          style={{ transformOrigin: `${center}px ${center}px` }}
        >
          <Silhouette
            kind={identity.silhouette}
            color={identity.color}
            center={center}
            scale={bodyScale}
            muted={style.intensity === 0}
          />
        </motion.g>

        {/* Work indicator: a small activity mark that only appears while the
            agent is actually doing something. Distinct per motion class so
            "working" and "waiting" read differently even at a glance. */}
        {!reduceMotion && (style.motion === 'work' || style.motion === 'wait') && size >= 44 && (
          <WorkIndicator
            center={center}
            radius={ringRadius}
            color={style.color}
            kind={style.motion}
          />
        )}

        {/* Failure and blocked states get a static mark rather than an
            animation. The skill is explicit that a failed agent should stop,
            not flash — a looping alert is hard to look at and easy to ignore. */}
        {(state === 'failed' || state === 'blocked') && size >= 40 && (
          <g transform={`translate(${size - 8} ${8})`}>
            <circle r={7} fill="var(--surface-2)" stroke={style.color} strokeWidth={1.25} />
            <text
              y={3.5}
              textAnchor="middle"
              fontSize={9}
              fontWeight={700}
              fill={style.color}
              aria-hidden
            >
              {state === 'failed' ? '✕' : '!'}
            </text>
          </g>
        )}
      </svg>

      {showMonogram && size >= 44 && (
        <span
          className="pointer-events-none absolute font-mono font-semibold tracking-tight"
          style={{
            fontSize: Math.max(9, size * 0.17),
            color: 'var(--surface-2)',
            textShadow: '0 1px 2px rgb(0 0 0 / 0.35)',
          }}
        >
          {identity.short}
        </span>
      )}
    </motion.span>
  );
});

/**
 * The small activity mark that orbits a working agent.
 *
 * Two distinct behaviours, because "working" and "waiting on someone else" are
 * the two states an operator most needs to tell apart and a single spinner
 * conflates them:
 *
 *  - `work` — a satellite travelling the ring, continuous and purposeful.
 *  - `wait` — three dots that fill and empty in place, going nowhere.
 *
 * Both are pure `transform`/`opacity` animations so they stay on the compositor
 * and cost nothing to run on a canvas of a dozen agents.
 */
function WorkIndicator({
  center,
  radius,
  color,
  kind,
}: {
  center: number;
  radius: number;
  color: string;
  kind: 'work' | 'wait';
}) {
  if (kind === 'wait') {
    return (
      <g transform={`translate(${center} ${center + radius - 1})`} aria-hidden>
        {[-4, 0, 4].map((dx, index) => (
          <motion.circle
            key={dx}
            cx={dx}
            r={1.5}
            fill={color}
            animate={{ opacity: [0.25, 1, 0.25] }}
            transition={{ duration: 1.5, repeat: Infinity, delay: index * 0.2, ease: 'easeInOut' }}
          />
        ))}
      </g>
    );
  }

  return (
    <motion.g
      aria-hidden
      style={{ transformOrigin: `${center}px ${center}px` }}
      animate={{ rotate: 360 }}
      transition={{ duration: 3.2, repeat: Infinity, ease: 'linear' }}
    >
      <circle cx={center} cy={center - radius} r={2.25} fill={color} />
    </motion.g>
  );
}

/**
 * The role-specific geometry.
 *
 * Drawn on a 64×64 reference grid and scaled, so every silhouette keeps the same
 * optical weight at any size. Kept as one switch rather than six components
 * because they share the grid and are only meaningful together.
 */
function Silhouette({
  kind,
  color,
  center,
  scale,
  muted,
}: {
  kind: AgentSilhouette;
  color: string;
  center: number;
  scale: number;
  muted: boolean;
}) {
  // Idle agents are dimmed a little, not faded out: the silhouette is the
  // primary way a role is identified, so it stays legible in every state.
  const opacity = muted ? 0.82 : 1;
  const u = (n: number) => n * scale;
  const t = `translate(${center} ${center}) scale(${scale})`;

  switch (kind) {
    case 'hub':
      // Concentric rings with spokes: the thing everything else connects to.
      return (
        <g transform={t} opacity={opacity}>
          <circle r={19} fill={color} opacity={0.16} />
          <circle r={19} fill="none" stroke={color} strokeWidth={1.5} />
          <circle r={11} fill={color} />
          {[0, 60, 120, 180, 240, 300].map((deg) => (
            <line
              key={deg}
              x1={0}
              y1={-13}
              x2={0}
              y2={-19}
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              transform={`rotate(${deg})`}
            />
          ))}
        </g>
      );

    case 'compass':
      // A needle in a dial: sets direction before anyone builds.
      return (
        <g transform={t} opacity={opacity}>
          <circle r={19} fill={color} opacity={0.16} />
          <circle r={19} fill="none" stroke={color} strokeWidth={1.5} />
          <path d="M 0 -14 L 6 4 L 0 0 L -6 4 Z" fill={color} />
          <circle r={2.5} fill="var(--surface-2)" />
        </g>
      );

    case 'stack':
      // Layered slabs: services and data, one on top of another.
      return (
        <g transform={t} opacity={opacity}>
          <circle r={19} fill={color} opacity={0.16} />
          {[-8, 0, 8].map((dy, i) => (
            <rect
              key={dy}
              x={-13}
              y={dy - 4}
              width={26}
              height={7}
              rx={2}
              fill={color}
              opacity={1 - i * 0.22}
            />
          ))}
        </g>
      );

    case 'window':
      // A framed viewport with a title bar: what the user actually sees.
      return (
        <g transform={t} opacity={opacity}>
          <circle r={19} fill={color} opacity={0.16} />
          <rect x={-14} y={-11} width={28} height={22} rx={3} fill="none" stroke={color} strokeWidth={2.5} />
          <line x1={-14} y1={-4} x2={14} y2={-4} stroke={color} strokeWidth={2.5} />
          <circle cx={-10} cy={-7.5} r={1.4} fill={color} />
          <circle cx={-5.5} cy={-7.5} r={1.4} fill={color} />
        </g>
      );

    case 'shield':
      // A shield with a check: what stands between a change and the branch.
      return (
        <g transform={t} opacity={opacity}>
          <circle r={19} fill={color} opacity={0.16} />
          <path
            d="M 0 -14 L 12 -9 L 12 3 Q 12 11 0 15 Q -12 11 -12 3 L -12 -9 Z"
            fill={color}
            opacity={0.9}
          />
          <path
            d="M -5 0 L -1.5 4 L 5.5 -4"
            fill="none"
            stroke="var(--surface-2)"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      );

    case 'page':
    default:
      // Leaves of paper with a folded corner and ruled lines.
      return (
        <g transform={t} opacity={opacity}>
          <circle r={19} fill={color} opacity={0.16} />
          <path d="M -10 -13 L 4 -13 L 11 -6 L 11 13 L -10 13 Z" fill={color} opacity={0.92} />
          <path d="M 4 -13 L 4 -6 L 11 -6" fill="none" stroke="var(--surface-2)" strokeWidth={1.6} />
          {[-1, 3, 7].map((y) => (
            <line
              key={y}
              x1={-6}
              y1={y}
              x2={u(7) / scale}
              y2={y}
              stroke="var(--surface-2)"
              strokeWidth={1.4}
              strokeLinecap="round"
              opacity={0.85}
            />
          ))}
        </g>
      );
  }
}

/**
 * The state badge that accompanies an avatar in dense layouts.
 *
 * Separate from the avatar so a list can put it where the layout wants it, and
 * so the glyph + label pair travels together — state must never be colour alone.
 */
export function AgentStateBadge({ state, compact = false }: { state: AgentState; compact?: boolean }) {
  const style = AGENT_STATE[state];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: style.color,
        background: `color-mix(in srgb, ${style.color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${style.color} 28%, transparent)`,
      }}
      title={style.hint}
    >
      <span aria-hidden>{style.glyph}</span>
      {!compact && style.label}
    </span>
  );
}
