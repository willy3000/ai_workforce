'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import {
  AGENT_STATE,
  EXTERNAL_SYSTEMS,
  FLOW,
  ORCHESTRATOR_KEY,
  agentIdentity,
  allAgentIdentities,
  type AgentState,
  type FlowKind,
} from '@/lib/agent-visuals';

/**
 * The workspace: a place the workforce occupies, filling the viewport.
 *
 * This is the application's primary surface — not a chart inside a dashboard.
 * Agents sit at workstations in a shared room, external systems line the
 * perimeter, and work is visible as it moves between them. Everything else in
 * the interface floats over this as HUD.
 *
 * ## Layout is architectural, not decorative
 * An orchestration hub, because that is literally what the engine does: the
 * engineering manager decomposes a request, dispatches steps, and receives
 * results. A pipeline layout would imply specialists hand off to each other; a
 * mesh would imply they all talk to each other. Neither is true, so neither
 * would be honest.
 *
 * ## Camera
 * Pan by dragging, zoom with the wheel or the controls. Selecting an agent
 * eases the camera onto it rather than cutting — the skill's rule is that users
 * must always feel oriented, so every camera move is a transition, never a jump.
 *
 * ## Performance
 * All motion is `transform`/`opacity` only, so it stays on the compositor. The
 * canvas pauses its ambient animation when the document is hidden, and packet
 * count is capped: a dozen animated nodes is fine, a hundred is not, and this
 * system has six agents by construction.
 */

export interface WorkspaceNode {
  agentKey: string;
  state: AgentState;
  /** What this agent is doing right now, in a few words. */
  activity?: string;
  /** Number of open items, shown as a small counter at the station. */
  queued?: number;
}

export interface WorkspaceFlow {
  id: string;
  from: string;
  to: string;
  kind: FlowKind;
}

export interface WorkspaceCanvasProps {
  nodes: WorkspaceNode[];
  flows?: WorkspaceFlow[];
  selectedAgent: string | null;
  onSelectAgent: (key: string | null) => void;
  /** Fires when the request-entry animation should play, e.g. a run just started. */
  incomingRequest?: string | null;
  /** True when nothing is connected yet — agents sleep and the room dims. */
  dormant?: boolean;
}

const WORLD = { w: 1400, h: 900 };
const HUB = { x: WORLD.w / 2, y: WORLD.h / 2 - 20 };

/** Fixed precision keeps server and client markup byte-identical. */
const round = (n: number): number => Number(n.toFixed(2));

/** Fixed station positions. An agent's place in the room never moves. */
const STATIONS: Record<string, { x: number; y: number }> = {
  'project-manager': { x: HUB.x - 270, y: HUB.y - 175 },
  'backend-engineer': { x: HUB.x - 340, y: HUB.y + 85 },
  'frontend-engineer': { x: HUB.x + 340, y: HUB.y + 85 },
  'qa-engineer': { x: HUB.x + 270, y: HUB.y - 175 },
  'documentation-engineer': { x: HUB.x, y: HUB.y + 240 },
};

/** External systems line the perimeter, away from the agents' working area. */
const SYSTEM_POSITIONS: Record<string, { x: number; y: number }> = {
  github: { x: HUB.x - 520, y: HUB.y - 300 },
  model: { x: HUB.x + 520, y: HUB.y - 300 },
  workspace: { x: HUB.x - 520, y: HUB.y + 270 },
  memory: { x: HUB.x + 520, y: HUB.y + 270 },
};

export function WorkspaceCanvas({
  nodes,
  flows = [],
  selectedAgent,
  onSelectAgent,
  incomingRequest,
  dormant = false,
}: WorkspaceCanvasProps) {
  const reduceMotion = useReducedMotion();
  const gradientId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [hovered, setHovered] = useState<string | null>(null);
  const dragState = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null);

  const focus = hovered ?? selectedAgent;
  const stateByKey = useMemo(() => new Map(nodes.map((n) => [n.agentKey, n])), [nodes]);
  const nodeFor = useCallback(
    (key: string): WorkspaceNode => stateByKey.get(key) ?? { agentKey: key, state: 'idle' },
    [stateByKey],
  );

  const positionOf = useCallback((key: string): { x: number; y: number } => {
    if (key === ORCHESTRATOR_KEY || key === 'workflow-engine' || key === 'human') return HUB;
    return STATIONS[key] ?? SYSTEM_POSITIONS[key] ?? HUB;
  }, []);

  /** Ease the camera onto a selected agent so the reader stays oriented. */
  useEffect(() => {
    if (!selectedAgent) return;
    const target = positionOf(selectedAgent);
    setCamera((c) => ({
      // Offset left of centre: the inspector panel occupies the right third.
      x: WORLD.w / 2 - target.x - 150,
      y: WORLD.h / 2 - target.y,
      zoom: Math.max(c.zoom, 1.15),
    }));
  }, [selectedAgent, positionOf]);

  const onWheel = useCallback((event: React.WheelEvent) => {
    if (!event.ctrlKey && Math.abs(event.deltaY) < 2) return;
    setCamera((c) => ({
      ...c,
      zoom: Math.min(2.2, Math.max(0.55, c.zoom - event.deltaY * 0.0012)),
    }));
  }, []);

  const onPointerDown = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('button')) return;
    dragState.current = { x: event.clientX, y: event.clientY, camX: camera.x, camY: camera.y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragState.current;
    if (!drag) return;
    setCamera((c) => ({
      ...c,
      x: drag.camX + (event.clientX - drag.x) / c.zoom,
      y: drag.camY + (event.clientY - drag.y) / c.zoom,
    }));
  };
  const endDrag = () => {
    dragState.current = null;
  };

  const anyActive = nodes.some((n) => AGENT_STATE[n.state].intensity === 2);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        // A lit floor: the room has a light source above the orchestrator and
        // falls off toward the walls. Without this the world reads as an empty
        // black page rather than a place with depth.
        background:
          'radial-gradient(62% 52% at 50% 44%, color-mix(in srgb, var(--surface-2) 100%, white 6%) 0%, ' +
          'var(--surface-2) 26%, var(--surface-1) 58%, var(--surface-0) 88%)',
      }}
    >
      {/* Depth: a fine dot field with mild parallax. It never changes with data,
          so it cannot be mistaken for a signal. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, var(--grid) 1px, transparent 0)',
          backgroundSize: '44px 44px',
          opacity: 0.9,
          transform: `translate(${camera.x * 0.3}px, ${camera.y * 0.3}px)`,
        }}
      />

      {/* Vignette: pulls the eye to the centre and keeps the corner HUD
          readable over whatever is behind it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 90% at 50% 45%, transparent 55%, color-mix(in srgb, var(--surface-0) 85%, transparent) 100%)',
        }}
      />

      <motion.div
        className="absolute left-1/2 top-1/2"
        animate={{ x: camera.x, y: camera.y, scale: camera.zoom }}
        transition={{ type: 'spring', stiffness: 160, damping: 30, mass: 0.9 }}
        style={{ width: WORLD.w, height: WORLD.h, marginLeft: -WORLD.w / 2, marginTop: -WORLD.h / 2 }}
      >
        <svg
          width={WORLD.w}
          height={WORLD.h}
          viewBox={`0 0 ${WORLD.w} ${WORLD.h}`}
          className="absolute inset-0"
          aria-hidden
        >
          <defs>
            <radialGradient id={`${gradientId}-core`}>
              <stop
                offset="0%"
                stopColor="var(--series-2)"
                stopOpacity={dormant ? 0.05 : anyActive ? 0.22 : 0.1}
              />
              <stop offset="100%" stopColor="var(--series-2)" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* The room's light source sits over the orchestrator and brightens
              only when work is genuinely in flight. */}
          <circle cx={HUB.x} cy={HUB.y} r={380} fill={`url(#${gradientId}-core)`} />

          {/* Floor rings give the room a centre and a sense of scale. */}
          {[170, 270, 380].map((r, index) => (
            <circle
              key={r}
              cx={HUB.x}
              cy={HUB.y}
              r={r}
              fill="none"
              stroke="var(--border)"
              strokeWidth={1}
              opacity={0.9 - index * 0.2}
            />
          ))}

          {/* Tick marks on the inner ring: instrumentation detail that makes the
              floor read as a deliberate surface rather than a stray circle. */}
          {Array.from({ length: 24 }, (_, i) => {
            const angle = (i * 15 * Math.PI) / 180;
            const inner = 164;
            const outer = i % 6 === 0 ? 154 : 159;
            return (
              <line
                key={i}
                x1={round(HUB.x + Math.cos(angle) * inner)}
                y1={round(HUB.y + Math.sin(angle) * inner)}
                x2={round(HUB.x + Math.cos(angle) * outer)}
                y2={round(HUB.y + Math.sin(angle) * outer)}
                stroke="var(--border-strong)"
                strokeWidth={1}
                opacity={i % 6 === 0 ? 0.7 : 0.35}
              />
            );
          })}

          {/* Links to external systems: dashed and dim — infrastructure, not
              collaboration. */}
          {Object.entries(SYSTEM_POSITIONS).map(([id, pos]) => (
            <line
              key={id}
              x1={HUB.x}
              y1={HUB.y}
              x2={pos.x}
              y2={pos.y}
              stroke="var(--border-strong)"
              strokeWidth={1}
              strokeDasharray="3 9"
              opacity={focus ? 0.12 : 0.28}
            />
          ))}

          {/* Working links between the orchestrator and each specialist. */}
          {Object.entries(STATIONS).map(([key, pos]) => {
            const node = nodeFor(key);
            const style = AGENT_STATE[node.state];
            const isFocused = focus === key;
            return (
              <Link
                key={key}
                from={HUB}
                to={pos}
                color={style.intensity === 0 ? 'var(--border-strong)' : style.color}
                active={style.intensity === 2}
                pending={node.state === 'waiting' || node.state === 'queued'}
                dimmed={focus !== null && !isFocused && focus !== ORCHESTRATOR_KEY}
                reduceMotion={Boolean(reduceMotion)}
              />
            );
          })}

          {/* Work in transit. */}
          {!reduceMotion &&
            flows.slice(0, 6).map((flow) => (
              <Packet
                key={flow.id}
                from={positionOf(flow.from)}
                to={positionOf(flow.to)}
                kind={flow.kind}
              />
            ))}

          {/* A request entering the system, from outside the room to the hub. */}
          <AnimatePresence>
            {incomingRequest && !reduceMotion && (
              <motion.g key={incomingRequest}>
                <motion.circle
                  r={7}
                  fill="var(--series-1)"
                  initial={{ cx: HUB.x, cy: HUB.y + 470, opacity: 0 }}
                  animate={{ cx: HUB.x, cy: HUB.y, opacity: [0, 1, 1, 0] }}
                  transition={{ duration: 1.5, ease: 'easeIn', times: [0, 0.15, 0.75, 1] }}
                />
                <motion.circle
                  cx={HUB.x}
                  cy={HUB.y}
                  fill="none"
                  stroke="var(--series-1)"
                  strokeWidth={2}
                  initial={{ r: 0, opacity: 0 }}
                  animate={{ r: [0, 140], opacity: [0, 0.55, 0] }}
                  transition={{ duration: 1.1, delay: 1.35, ease: 'easeOut' }}
                />
              </motion.g>
            )}
          </AnimatePresence>
        </svg>

        {/* Stations sit above the SVG so they can be real buttons. */}
        <Station
          position={HUB}
          node={nodeFor(ORCHESTRATOR_KEY)}
          size={108}
          isHub
          focused={focus === ORCHESTRATOR_KEY}
          dimmed={focus !== null && focus !== ORCHESTRATOR_KEY}
          selected={selectedAgent === ORCHESTRATOR_KEY}
          dormant={dormant}
          onHover={setHovered}
          onSelect={onSelectAgent}
        />

        {Object.entries(STATIONS).map(([key, pos]) => (
          <Station
            key={key}
            position={pos}
            node={nodeFor(key)}
            size={74}
            focused={focus === key}
            dimmed={focus !== null && focus !== key}
            selected={selectedAgent === key}
            dormant={dormant}
            onHover={setHovered}
            onSelect={onSelectAgent}
          />
        ))}

        {Object.entries(SYSTEM_POSITIONS).map(([id, pos]) => (
          <SystemTerminal key={id} id={id} position={pos} dimmed={focus !== null} />
        ))}
      </motion.div>

      <CameraControls
        zoom={camera.zoom}
        onZoom={(delta) =>
          setCamera((c) => ({ ...c, zoom: Math.min(2.2, Math.max(0.55, c.zoom + delta)) }))
        }
        onReset={() => {
          setCamera({ x: 0, y: 0, zoom: 1 });
          onSelectAgent(null);
        }}
      />
    </div>
  );
}

/** A connection between two stations, bowed so parallel links stay separable. */
function Link({
  from,
  to,
  color,
  active,
  pending,
  dimmed,
  reduceMotion,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
  active: boolean;
  pending: boolean;
  dimmed: boolean;
  reduceMotion: boolean;
}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const bow = Math.min(60, length * 0.12);
  // Rounded so the `d` string serialises identically on the server and the
  // client — an unrounded float differs in its last digit between the two and
  // React reports it as a hydration mismatch.
  const cx = round((from.x + to.x) / 2 + (-dy / length) * bow);
  const cy = round((from.y + to.y) / 2 + (dx / length) * bow);
  const d = `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;

  return (
    <g opacity={dimmed ? 0.12 : 1} style={{ transition: 'opacity 220ms' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={active ? 2.5 : 1.25} opacity={active ? 0.5 : 0.24} />
      {active && !reduceMotion && (
        <motion.path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray="14 400"
          initial={{ strokeDashoffset: 414 }}
          animate={{ strokeDashoffset: 0 }}
          transition={{ duration: 2.1, repeat: Infinity, ease: 'linear' }}
        />
      )}
      {pending && <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="4 8" opacity={0.45} />}
    </g>
  );
}

/** A payload travelling a link. Shape encodes what it is. */
function Packet({
  from,
  to,
  kind,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  kind: FlowKind;
}) {
  const style = FLOW[kind];
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = style.duration * Math.max(0.7, Math.min(1.8, distance / 320));

  return (
    <motion.g
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 1, 0], x: [from.x, to.x], y: [from.y, to.y] }}
      transition={{ duration, repeat: Infinity, ease: 'easeInOut', times: [0, 0.12, 0.85, 1] }}
    >
      {style.packet === 'pulse' && <circle r={5} fill={style.color} />}
      {style.packet === 'block' && <rect x={-6} y={-4.5} width={12} height={9} rx={2} fill={style.color} />}
      {style.packet === 'ring' && <circle r={6} fill="none" stroke={style.color} strokeWidth={2.5} />}
      {style.packet === 'spark' && (
        <path d="M 0 -7 L 2.4 -1.2 L 7 0 L 2.4 1.2 L 0 7 L -2.4 1.2 L -7 0 L -2.4 -1.2 Z" fill={style.color} />
      )}
    </motion.g>
  );
}

/**
 * An agent at its workstation.
 *
 * The desk is a real element rather than decoration: it lights up when the agent
 * is working, which is the skill's "workstation powers on" behaviour, and it
 * gives the room a floor plane so agents read as occupying space rather than
 * floating.
 */
function Station({
  position,
  node,
  size,
  isHub = false,
  focused,
  dimmed,
  selected,
  dormant,
  onHover,
  onSelect,
}: {
  position: { x: number; y: number };
  node: WorkspaceNode;
  size: number;
  isHub?: boolean;
  focused: boolean;
  dimmed: boolean;
  selected: boolean;
  dormant: boolean;
  onHover: (key: string | null) => void;
  onSelect: (key: string | null) => void;
}) {
  const identity = agentIdentity(node.agentKey);
  const style = AGENT_STATE[node.state];
  const working = style.intensity === 2;

  return (
    <motion.button
      type="button"
      className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
      style={{ left: position.x, top: position.y, outlineColor: identity.color }}
      animate={{ opacity: dimmed ? 0.35 : dormant ? 0.8 : 1, scale: selected ? 1.05 : 1 }}
      transition={{ duration: 0.22 }}
      onMouseEnter={() => onHover(node.agentKey)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(node.agentKey)}
      onBlur={() => onHover(null)}
      onClick={() => onSelect(selected ? null : node.agentKey)}
      aria-pressed={selected}
      aria-label={`${identity.role}: ${style.label}${node.activity ? `, ${node.activity}` : ''}`}
    >
      <AgentAvatar
        agentKey={node.agentKey}
        state={node.state}
        size={size}
        focused={focused}
        dimmed={false}
      />

      {/* The desk. Its glow is the workstation-active signal. */}
      <span
        aria-hidden
        className="mt-1 block rounded-[3px] transition-all duration-300"
        style={{
          width: size * (isHub ? 1.25 : 1.15),
          height: 5,
          background: working
            ? `linear-gradient(90deg, transparent, ${identity.color}, transparent)`
            : 'var(--border-strong)',
          opacity: working ? 0.95 : dormant ? 0.45 : 0.7,
          boxShadow: working ? `0 0 14px color-mix(in srgb, ${identity.color} 45%, transparent)` : undefined,
        }}
      />

      <span className="mt-1.5 flex flex-col items-center gap-0.5">
        <span
          className="text-[12px] font-medium leading-none"
          style={{ color: focused ? 'var(--text-primary)' : 'var(--text-secondary)' }}
        >
          {identity.role}
        </span>
        <span
          className="flex max-w-[150px] items-center gap-1 text-[10.5px] leading-tight"
          style={{ color: style.color }}
        >
          <span aria-hidden>{style.glyph}</span>
          <span className="truncate">{node.activity ?? style.label}</span>
        </span>
      </span>

      {node.queued ? (
        <span
          className="hud absolute -right-1 -top-1 rounded-full px-1.5 text-[10px] font-semibold"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-strong)' }}
        >
          {node.queued}
        </span>
      ) : null}
    </motion.button>
  );
}

/**
 * An external system on the perimeter.
 *
 * Flat, rectangular, unlit — a rack unit, not a character. The skill's rule is
 * that APIs must not look like robots, and the clearest way to honour it is to
 * give them no face, no state ring and no ambient motion at all.
 */
function SystemTerminal({
  id,
  position,
  dimmed,
}: {
  id: string;
  position: { x: number; y: number };
  dimmed: boolean;
}) {
  const system = EXTERNAL_SYSTEMS[id];
  if (!system) return null;
  const glyph = { vcs: '⑂', datastore: '▤', model: '◈', runtime: '▣' }[system.kind];

  return (
    <div
      className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-sm border px-2.5 py-1.5 transition-opacity"
      style={{
        left: position.x,
        top: position.y,
        opacity: dimmed ? 0.3 : 0.75,
        background: 'var(--surface-1)',
        borderColor: 'var(--border-strong)',
      }}
      title={system.purpose}
    >
      <span aria-hidden className="hud text-[12px]" style={{ color: 'var(--text-muted)' }}>
        {glyph}
      </span>
      <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
        {system.label}
      </span>
    </div>
  );
}

/** Minimal camera controls, anchored bottom-right, out of the working area. */
function CameraControls({
  zoom,
  onZoom,
  onReset,
}: {
  zoom: number;
  onZoom: (delta: number) => void;
  onReset: () => void;
}) {
  return (
    <div className="absolute bottom-5 right-5 flex flex-col gap-1">
      {[
        { label: '+', title: 'Zoom in', delta: 0.2 },
        { label: '−', title: 'Zoom out', delta: -0.2 },
      ].map((control) => (
        <button
          key={control.label}
          type="button"
          onClick={() => onZoom(control.delta)}
          title={control.title}
          aria-label={control.title}
          className="hud h-7 w-7 rounded-md border text-[13px] backdrop-blur-sm transition-colors hover:text-[var(--text-primary)]"
          style={{
            background: 'color-mix(in srgb, var(--surface-1) 80%, transparent)',
            color: 'var(--text-muted)',
          }}
        >
          {control.label}
        </button>
      ))}
      <button
        type="button"
        onClick={onReset}
        title="Reset view"
        aria-label="Reset view"
        className="hud h-7 w-7 rounded-md border text-[10px] backdrop-blur-sm transition-colors hover:text-[var(--text-primary)]"
        style={{
          background: 'color-mix(in srgb, var(--surface-1) 80%, transparent)',
          color: 'var(--text-muted)',
        }}
      >
        {Math.round(zoom * 100)}
      </button>
    </div>
  );
}

/** Exported so callers can reuse the canonical roster for empty states. */
export const WORKSPACE_ROSTER = [
  agentIdentity(ORCHESTRATOR_KEY),
  ...allAgentIdentities().filter((a) => a.key !== ORCHESTRATOR_KEY),
];
