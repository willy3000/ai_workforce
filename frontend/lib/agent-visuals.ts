import type { StepStatus, TaskStatus } from './types';

/**
 * Visual semantics for the agent workforce.
 *
 * This is the single place that answers "what does this agent look like" and
 * "what does this state look like". Every canvas, card, avatar and edge reads
 * from here, so the same role is recognisable in the orchestration view, the run
 * timeline and the task board without anyone re-deciding.
 *
 * Two rules the whole system depends on:
 *
 *  1. **Identity is a fixed lookup, never computed from position.** An agent's
 *     hue and silhouette are properties of the agent, not of where it happens to
 *     sit in a filtered array. If these came from `indexOf`, filtering the
 *     roster would repaint the survivors and destroy the identity a reader had
 *     just learned.
 *  2. **State is never carried by colour alone.** Each state ships a colour, a
 *     glyph, a label, and a motion behaviour. A reader who cannot distinguish
 *     the hues still gets three independent signals.
 */

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

/**
 * The silhouette an agent is drawn with.
 *
 * Distinct shapes are what let a reader tell roles apart at a glance and at
 * small sizes — the skill's "do not use identical visual treatment for all
 * agents". Each shape is also a rough metaphor for the work: the orchestrator is
 * a hub, the backend engineer a stack of servers, the QA engineer a shield.
 */
export type AgentSilhouette =
  | 'hub'       // orchestrator / engineering manager — concentric, central
  | 'compass'   // planner / project manager — directional
  | 'stack'     // backend — layered slabs
  | 'window'    // frontend — framed panes
  | 'shield'    // QA — protective
  | 'page';     // documentation — leaves of paper

export interface AgentIdentity {
  key: string;
  /** Two-to-three letter monogram for dense contexts. */
  short: string;
  /** Human-facing role noun used in captions. */
  role: string;
  silhouette: AgentSilhouette;
  /** Fixed categorical slot from the design tokens. */
  color: string;
  /** What this role contributes, in one clause, for tooltips and empty states. */
  purpose: string;
}

const IDENTITIES: Record<string, AgentIdentity> = {
  'engineering-manager': {
    key: 'engineering-manager',
    short: 'EM',
    role: 'Orchestrator',
    silhouette: 'hub',
    color: 'var(--series-2)',
    purpose: 'Breaks work down, assigns it, and reviews what comes back',
  },
  'project-manager': {
    key: 'project-manager',
    short: 'PM',
    role: 'Planner',
    silhouette: 'compass',
    color: 'var(--series-1)',
    purpose: 'Turns a request into scoped, ordered tasks with acceptance criteria',
  },
  'backend-engineer': {
    key: 'backend-engineer',
    short: 'BE',
    role: 'Backend',
    silhouette: 'stack',
    color: 'var(--series-3)',
    purpose: 'Implements services, data access and APIs',
  },
  'frontend-engineer': {
    key: 'frontend-engineer',
    short: 'FE',
    role: 'Frontend',
    silhouette: 'window',
    color: 'var(--series-4)',
    purpose: 'Implements interfaces, state and client behaviour',
  },
  'qa-engineer': {
    key: 'qa-engineer',
    short: 'QA',
    role: 'Verifier',
    silhouette: 'shield',
    color: 'var(--series-5)',
    purpose: 'Runs the tests and reports what actually passed',
  },
  'documentation-engineer': {
    key: 'documentation-engineer',
    short: 'DOC',
    role: 'Scribe',
    silhouette: 'page',
    color: 'var(--series-6)',
    purpose: 'Keeps the written record honest after the code changes',
  },
};

const FALLBACK: AgentIdentity = {
  key: 'unknown',
  short: '??',
  role: 'Agent',
  silhouette: 'hub',
  color: 'var(--text-muted)',
  purpose: 'Role not registered on this platform',
};

export function agentIdentity(key: string): AgentIdentity {
  return IDENTITIES[key] ?? { ...FALLBACK, key, short: key.slice(0, 3).toUpperCase() };
}

export function allAgentIdentities(): AgentIdentity[] {
  return Object.values(IDENTITIES);
}

/** The role that sits at the centre of the orchestration canvas. */
export const ORCHESTRATOR_KEY = 'engineering-manager';

// ---------------------------------------------------------------------------
// External systems
// ---------------------------------------------------------------------------

/**
 * Things the workforce talks to that are *not* agents.
 *
 * Deliberately a different visual language — rectangular plates rather than the
 * agents' rounded silhouettes — because the skill is explicit that "external
 * systems should look different from agents" and "avoid making APIs look like
 * robots". A reader should never wonder whether GitHub is a teammate.
 */
export type ExternalSystemKind = 'vcs' | 'datastore' | 'model' | 'runtime';

export interface ExternalSystem {
  id: string;
  label: string;
  kind: ExternalSystemKind;
  /** One line explaining what the platform uses it for. */
  purpose: string;
}

export const EXTERNAL_SYSTEMS: Record<string, ExternalSystem> = {
  github: {
    id: 'github',
    label: 'GitHub',
    kind: 'vcs',
    purpose: 'Source of the checkout; destination for branches and pull requests',
  },
  workspace: {
    id: 'workspace',
    label: 'Checkout',
    kind: 'runtime',
    purpose: 'The working tree agents read and write, one per project',
  },
  model: {
    id: 'model',
    label: 'Model',
    kind: 'model',
    purpose: 'The reasoning provider every agent turn is billed against',
  },
  memory: {
    id: 'memory',
    label: 'Memory',
    kind: 'datastore',
    purpose: 'Project conventions, decisions and change history',
  },
};

// ---------------------------------------------------------------------------
// Agent state model
// ---------------------------------------------------------------------------

/**
 * The lifecycle an agent node can be in.
 *
 * Richer than the backend's task status on purpose: `starting` and `retrying`
 * are transient presentation states that make a transition legible, and
 * `waiting` distinguishes "blocked on a dependency" from "blocked on a problem",
 * which the operator needs and a single `blocked` cannot express.
 */
export type AgentState =
  | 'idle'
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'retrying'
  | 'failed'
  | 'cancelled'
  | 'completed';

/**
 * How a state looks and behaves.
 *
 * `intensity` drives the visual-hierarchy rule: only a few things should command
 * attention at once, so idle parts of the canvas stay calm and the active ones
 * glow. `pulse` is the ambient animation, suppressed entirely under reduced
 * motion.
 */
export interface AgentStateStyle {
  label: string;
  glyph: string;
  color: string;
  /** 0 = recede, 1 = normal, 2 = command attention. */
  intensity: 0 | 1 | 2;
  /** Ambient animation for the node while in this state. */
  motion: 'none' | 'breathe' | 'work' | 'wait' | 'alert';
  /** One line the operator can act on. */
  hint: string;
}

export const AGENT_STATE: Record<AgentState, AgentStateStyle> = {
  idle: {
    label: 'Ready',
    glyph: '○',
    // `--text-secondary`, not `--text-muted`: an idle agent must read as
    // *available*, not as disabled. Muting it to near-invisibility made an empty
    // workspace look broken rather than waiting.
    color: 'var(--text-secondary)',
    intensity: 0,
    motion: 'breathe',
    hint: 'Available — no work assigned',
  },
  queued: {
    label: 'Queued',
    glyph: '◔',
    color: 'var(--text-secondary)',
    intensity: 1,
    motion: 'breathe',
    hint: 'Work accepted, waiting for a slot',
  },
  starting: {
    label: 'Starting',
    glyph: '◑',
    color: 'var(--series-1)',
    intensity: 1,
    motion: 'work',
    hint: 'Loading project context',
  },
  running: {
    label: 'Running',
    glyph: '▶',
    color: 'var(--series-1)',
    intensity: 2,
    motion: 'work',
    hint: 'Working now',
  },
  waiting: {
    label: 'Waiting',
    glyph: '⋯',
    color: 'var(--status-warning)',
    intensity: 1,
    motion: 'wait',
    hint: 'Waiting on another step to finish',
  },
  blocked: {
    label: 'Blocked',
    glyph: '⚠',
    color: 'var(--status-serious)',
    intensity: 2,
    motion: 'alert',
    hint: 'Cannot proceed — needs a decision from you',
  },
  retrying: {
    label: 'Retrying',
    glyph: '↻',
    color: 'var(--status-warning)',
    intensity: 2,
    motion: 'work',
    hint: 'Previous attempt failed; trying again',
  },
  failed: {
    label: 'Failed',
    glyph: '✕',
    color: 'var(--status-critical)',
    intensity: 2,
    motion: 'none',
    hint: 'Stopped with an error — review before retrying',
  },
  cancelled: {
    label: 'Cancelled',
    glyph: '⊘',
    color: 'var(--text-muted)',
    intensity: 0,
    motion: 'none',
    hint: 'Stopped on request',
  },
  completed: {
    label: 'Completed',
    glyph: '✓',
    color: 'var(--status-good)',
    intensity: 1,
    motion: 'none',
    hint: 'Finished and reported',
  },
};

// ---------------------------------------------------------------------------
// Mapping backend state onto the visual model
// ---------------------------------------------------------------------------

/**
 * A workflow step's stored status becomes a node state.
 *
 * `waiting` cannot be derived from the step alone — it depends on whether an
 * earlier step is still running — so the caller supplies that context. This is
 * why the function takes the surrounding run rather than just the step: the
 * difference between "pending because nothing has started" and "pending because
 * it is next in line" is exactly what makes the canvas readable.
 */
export function stepState(
  status: StepStatus,
  context: { runActive: boolean; isNext: boolean; attempt?: number } = {
    runActive: false,
    isNext: false,
  },
): AgentState {
  switch (status) {
    case 'running':
      return (context.attempt ?? 1) > 1 ? 'retrying' : 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'cancelled';
    case 'awaiting_approval':
      return 'blocked';
    case 'pending':
      if (!context.runActive) return 'idle';
      return context.isNext ? 'queued' : 'waiting';
    default:
      return 'idle';
  }
}

/** A task's status becomes a node state, for the board and the roster. */
export function taskState(status: TaskStatus): AgentState {
  const map: Record<TaskStatus, AgentState> = {
    backlog: 'idle',
    ready: 'queued',
    in_progress: 'running',
    blocked: 'blocked',
    awaiting_review: 'waiting',
    awaiting_approval: 'blocked',
    done: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
  };
  return map[status] ?? 'idle';
}

// ---------------------------------------------------------------------------
// Data flow
// ---------------------------------------------------------------------------

/**
 * What is travelling along an edge.
 *
 * Different payloads get different visual forms, so a reader can tell an
 * instruction from a delivered artifact without a legend — the skill's
 * "different kinds of information may use different visual forms".
 */
export type FlowKind = 'instruction' | 'artifact' | 'review' | 'escalation' | 'result';

export interface FlowStyle {
  label: string;
  color: string;
  /** Shape of the travelling packet. */
  packet: 'pulse' | 'block' | 'ring' | 'spark';
  /** Seconds for one traversal, before distance scaling. */
  duration: number;
}

export const FLOW: Record<FlowKind, FlowStyle> = {
  instruction: { label: 'Instruction', color: 'var(--series-1)', packet: 'pulse', duration: 1.6 },
  artifact: { label: 'Changed files', color: 'var(--series-4)', packet: 'block', duration: 2.2 },
  review: { label: 'Review request', color: 'var(--series-5)', packet: 'ring', duration: 1.9 },
  escalation: { label: 'Escalation', color: 'var(--status-serious)', packet: 'spark', duration: 1.2 },
  result: { label: 'Result', color: 'var(--status-good)', packet: 'block', duration: 1.8 },
};

/**
 * Infer what kind of payload a message represents.
 *
 * Intents come from the backend message bus, so this is a presentation mapping
 * over real events — not invented activity. The skill is explicit: "do not
 * create fake random activity merely to make the UI look alive."
 */
export function flowKindForIntent(intent: string): FlowKind {
  switch (intent) {
    case 'escalation':
      return 'escalation';
    case 'review_request':
      return 'review';
    case 'review_result':
    case 'completion':
      return 'result';
    case 'handoff':
      return 'artifact';
    default:
      return 'instruction';
  }
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/**
 * Timing scale, from the skill's choreography guidance.
 *
 * Centralised so transitions feel like one system rather than a dozen
 * independently-chosen durations.
 */
export const MOTION = {
  micro: 0.18,
  panel: 0.28,
  activation: 0.42,
  completion: 0.6,
  ambient: 4,
  /** Spring used for anything that moves in space, so motion feels physical. */
  spring: { type: 'spring' as const, stiffness: 320, damping: 32, mass: 0.9 },
  /** Gentler spring for large surfaces, where a snappy one reads as jarring. */
  softSpring: { type: 'spring' as const, stiffness: 180, damping: 26, mass: 1 },
};

/**
 * Semantic progress labels, for when real progress is unknown.
 *
 * The skill's rule is "do not fake precision". An agent loop has no meaningful
 * percentage — it does not know how many iterations it needs — so showing "62%"
 * would be a lie. A phase name is honest and still tells the operator where in
 * the process the work is.
 */
export const RUN_PHASES = [
  'Gathering context',
  'Planning',
  'Executing',
  'Verifying',
  'Finalising',
] as const;

export function phaseForStep(index: number, total: number): string {
  if (total <= 1) return RUN_PHASES[2];
  const ratio = index / Math.max(1, total - 1);
  if (ratio < 0.2) return RUN_PHASES[0];
  if (ratio < 0.4) return RUN_PHASES[1];
  if (ratio < 0.75) return RUN_PHASES[2];
  if (ratio < 0.95) return RUN_PHASES[3];
  return RUN_PHASES[4];
}
