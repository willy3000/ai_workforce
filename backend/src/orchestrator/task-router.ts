import { agentRegistry } from '../agents/registry';
import type { AgentDefinition } from '../agents/types';
import type { ITask, TaskType } from '../database/models/task.model';
import { extractKeywords } from '../utils/text';

/**
 * Task → agent routing.
 *
 * Two-stage, deterministic by design:
 *
 *   1. **Type mapping** — a task's `type` is an explicit, human/PM-set signal and
 *      is honoured first. Routing that already knows the answer should not be
 *      re-litigated by a scorer.
 *   2. **Capability scoring** — only when the type is ambiguous (`analysis`) or
 *      the mapped agent is unavailable, score the task text against each agent's
 *      declared capabilities.
 *
 * Deliberately *not* an LLM call: routing runs on every task, must be
 * predictable, and must be explainable to an operator asking "why did the
 * frontend agent get this?". The `reason` field carries that explanation.
 */
export interface RoutingDecision {
  agentKey: string;
  confidence: number;
  reason: string;
  alternatives: { agentKey: string; score: number }[];
}

const TYPE_TO_AGENT: Record<TaskType, string> = {
  planning: 'project-manager',
  architecture: 'engineering-manager',
  backend: 'backend-engineer',
  frontend: 'frontend-engineer',
  testing: 'qa-engineer',
  review: 'qa-engineer',
  documentation: 'documentation-engineer',
  bugfix: 'backend-engineer', // refined below by content scoring
  devops: 'engineering-manager', // no autonomous devops role: escalates for approval
  analysis: 'engineering-manager',
};

/** Signals that a task is frontend work even when its type says otherwise. */
const FRONTEND_SIGNALS = [
  'ui', 'component', 'page', 'view', 'css', 'style', 'button', 'form', 'modal',
  'layout', 'responsive', 'react', 'vue', 'svelte', 'tailwind', 'frontend',
  'client-side', 'browser', 'render', 'jsx', 'tsx',
];

const BACKEND_SIGNALS = [
  'api', 'endpoint', 'route', 'controller', 'service', 'database', 'model',
  'schema', 'migration', 'query', 'auth', 'token', 'webhook', 'queue', 'job',
  'server', 'backend', 'repository', 'sql', 'index',
];

export class TaskRouter {
  route(task: Pick<ITask, 'title' | 'description' | 'type'>): RoutingDecision {
    const text = `${task.title} ${task.description}`.toLowerCase();
    const scores = this.scoreAll(text);

    // Stage 1: explicit type mapping, with a content override for the two
    // types that are genuinely ambiguous.
    const mapped = TYPE_TO_AGENT[task.type];
    if (mapped && task.type !== 'analysis') {
      if (task.type === 'bugfix' || task.type === 'devops') {
        const frontendScore = this.signalScore(text, FRONTEND_SIGNALS);
        const backendScore = this.signalScore(text, BACKEND_SIGNALS);
        if (frontendScore > backendScore && frontendScore >= 2) {
          return this.decision('frontend-engineer', 0.75, `Task type '${task.type}', but the description is dominated by UI terms`, scores);
        }
      }
      return this.decision(mapped, 0.9, `Task type '${task.type}' maps to ${mapped}`, scores);
    }

    // Stage 2: capability scoring.
    const best = scores[0];
    if (!best || best.score === 0) {
      return this.decision(
        'engineering-manager',
        0.3,
        'No strong capability match; routed to the engineering-manager to triage',
        scores,
      );
    }

    const runnerUp = scores[1]?.score ?? 0;
    const confidence = Math.min(0.95, 0.5 + (best.score - runnerUp) / (best.score + 1));
    // The winning score can come from declared capabilities, from domain signal
    // terms, or both — say which, so the decision is explainable to an operator.
    const reason = best.matched.length
      ? `Capability match on: ${best.matched.join(', ')}`
      : `Domain terminology in the description matched ${best.agentKey} (score ${best.score})`;
    return this.decision(best.agentKey, confidence, reason, scores);
  }

  /** Which agents *could* take this task — used by the UI and the coordinator. */
  candidates(task: Pick<ITask, 'title' | 'description' | 'type'>): { agentKey: string; score: number }[] {
    return this.scoreAll(`${task.title} ${task.description}`.toLowerCase()).map((s) => ({
      agentKey: s.agentKey,
      score: s.score,
    }));
  }

  private scoreAll(text: string): { agentKey: string; score: number; matched: string[] }[] {
    const keywords = new Set(extractKeywords(text, 30));

    return agentRegistry
      .all()
      .map((agent: AgentDefinition) => {
        const matched: string[] = [];
        let score = 0;
        for (const capability of agent.capabilities) {
          const parts = capability.split('-');
          if (text.includes(capability.replace(/-/g, ' ')) || text.includes(capability)) {
            score += 3;
            matched.push(capability);
          } else if (parts.some((p) => p.length > 3 && keywords.has(p))) {
            score += 1;
            matched.push(capability);
          }
        }
        if (agent.key === 'frontend-engineer') score += this.signalScore(text, FRONTEND_SIGNALS);
        if (agent.key === 'backend-engineer') score += this.signalScore(text, BACKEND_SIGNALS);
        return { agentKey: agent.key, score, matched };
      })
      .sort((a, b) => b.score - a.score);
  }

  private signalScore(text: string, signals: string[]): number {
    return signals.reduce((total, signal) => (text.includes(signal) ? total + 1 : total), 0);
  }

  private decision(
    agentKey: string,
    confidence: number,
    reason: string,
    scores: { agentKey: string; score: number }[],
  ): RoutingDecision {
    return {
      agentKey,
      confidence,
      reason,
      alternatives: scores.filter((s) => s.agentKey !== agentKey).slice(0, 3),
    };
  }
}

export const taskRouter = new TaskRouter();
