import type { StepStatus, TaskStatus } from './types';

/**
 * Encoding decisions, centralised.
 *
 * Colour is assigned by the job it does — identity for agents, state for
 * statuses — and the assignment is a lookup table, never computed from an index
 * at render time. That guarantee matters: if agent colours came from
 * `array.indexOf`, filtering the roster would repaint the survivors and the
 * reader would lose the identity they had just learned.
 */

/** Fixed categorical slots. An agent's hue never changes, whatever is on screen. */
export const AGENT_COLOR: Record<string, string> = {
  'project-manager': 'var(--series-1)',
  'engineering-manager': 'var(--series-2)',
  'backend-engineer': 'var(--series-3)',
  'frontend-engineer': 'var(--series-4)',
  'qa-engineer': 'var(--series-5)',
  'documentation-engineer': 'var(--series-6)',
  human: 'var(--text-muted)',
  orchestrator: 'var(--text-muted)',
  'workflow-engine': 'var(--text-muted)',
  'task-router': 'var(--text-muted)',
};

export function agentColor(key: string): string {
  return AGENT_COLOR[key] ?? 'var(--text-muted)';
}

/** Short labels for the org chart nodes. */
export const AGENT_SHORT: Record<string, string> = {
  'project-manager': 'PM',
  'engineering-manager': 'EM',
  'backend-engineer': 'BE',
  'frontend-engineer': 'FE',
  'qa-engineer': 'QA',
  'documentation-engineer': 'DOC',
  human: 'YOU',
  orchestrator: 'SYS',
  'workflow-engine': 'SYS',
  'task-router': 'SYS',
};

export function agentShort(key: string): string {
  return AGENT_SHORT[key] ?? key.slice(0, 3).toUpperCase();
}

/**
 * Status encoding. Every status ships a colour AND a glyph AND a label —
 * state is never carried by colour alone.
 */
export interface StatusStyle {
  color: string;
  glyph: string;
  label: string;
}

const STATUS: Record<string, StatusStyle> = {
  // terminal success
  done: { color: 'var(--status-good)', glyph: '✓', label: 'Done' },
  completed: { color: 'var(--status-good)', glyph: '✓', label: 'Completed' },
  ready_state: { color: 'var(--status-good)', glyph: '✓', label: 'Ready' },
  // in motion
  running: { color: 'var(--series-1)', glyph: '▶', label: 'Running' },
  in_progress: { color: 'var(--series-1)', glyph: '▶', label: 'In progress' },
  analyzing: { color: 'var(--series-1)', glyph: '▶', label: 'Analyzing' },
  connecting: { color: 'var(--series-1)', glyph: '▶', label: 'Connecting' },
  // waiting on a human or a dependency
  awaiting_approval: { color: 'var(--status-warning)', glyph: '⏸', label: 'Needs approval' },
  awaiting_review: { color: 'var(--status-warning)', glyph: '⏸', label: 'Awaiting review' },
  blocked: { color: 'var(--status-serious)', glyph: '⚠', label: 'Blocked' },
  // failure
  failed: { color: 'var(--status-critical)', glyph: '✕', label: 'Failed' },
  cancelled: { color: 'var(--text-muted)', glyph: '⊘', label: 'Cancelled' },
  // inert
  pending: { color: 'var(--text-muted)', glyph: '○', label: 'Pending' },
  backlog: { color: 'var(--text-muted)', glyph: '○', label: 'Backlog' },
  ready: { color: 'var(--text-secondary)', glyph: '◔', label: 'Ready' },
  skipped: { color: 'var(--text-muted)', glyph: '⤳', label: 'Skipped' },
};

export function statusStyle(status: string): StatusStyle {
  return STATUS[status] ?? { color: 'var(--text-muted)', glyph: '·', label: status };
}

export const ACTIVE_STATUSES = new Set(['running', 'in_progress', 'analyzing', 'connecting']);
export const TERMINAL_STATUSES = new Set(['done', 'completed', 'failed', 'cancelled', 'skipped']);

export function isActive(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** Kanban column order for the task board. */
export const TASK_COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'ready', label: 'Ready' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'awaiting_approval', label: 'Needs approval' },
  { status: 'awaiting_review', label: 'In review' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
  { status: 'failed', label: 'Failed' },
];

export const STEP_ORDER: StepStatus[] = [
  'pending', 'running', 'awaiting_approval', 'completed', 'skipped', 'failed',
];

/** Knowledge kinds get their own stable identity colours in the memory explorer. */
export const KNOWLEDGE_COLOR: Record<string, string> = {
  architecture: 'var(--series-1)',
  convention: 'var(--series-2)',
  change: 'var(--series-3)',
  structure: 'var(--series-4)',
  important_file: 'var(--series-5)',
  known_issue: 'var(--series-6)',
  domain: 'var(--series-7)',
  requirement: 'var(--series-8)',
};
