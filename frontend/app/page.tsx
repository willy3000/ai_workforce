'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '@/lib/api';
import { useLocalState, usePoll } from '@/lib/hooks';
import { WorkspaceCanvas, type WorkspaceFlow, type WorkspaceNode } from '@/components/workspace/WorkspaceCanvas';
import { CommandConsole } from '@/components/workspace/CommandConsole';
import { AgentInspector } from '@/components/workspace/AgentInspector';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import {
  ORCHESTRATOR_KEY,
  agentIdentity,
  allAgentIdentities,
  flowKindForIntent,
  stepState,
  taskState,
  type AgentState,
} from '@/lib/agent-visuals';
import type { AgentMessage, Task, WorkflowRun } from '@/lib/types';

/**
 * The workspace.
 *
 * The whole viewport is the room the workforce occupies. There is no sidebar,
 * no header, and no grid of cards: the canvas is the application, and every
 * other element floats over it as instrumentation that appears when it has
 * something to say.
 *
 * ## What is on screen, and why
 *  - **The world** — agents at stations, external systems on the perimeter, work
 *    visibly moving between them.
 *  - **The console** — where a request enters the system.
 *  - **The inspector** — one agent's detail, only while selected.
 *  - **The alert strip** — appears only when something has stopped and is
 *    waiting for a human. It is absent when nothing is wrong, which is the
 *    difference between an interface that reports and one that nags.
 *
 * ## Nothing is invented
 * Every state and every packet comes from a real run, task or message. The skill
 * is explicit: do not create fake activity to make the UI look alive. An idle
 * platform renders as a calm, dim room — which is honest, and is itself the
 * answer to "is anything happening?".
 */
const ACTIVE_RUN = new Set(['queued', 'running', 'cancelling', 'awaiting_approval']);

export default function Workspace() {
  const [selectedProjectId, setSelectedProjectId] = useLocalState<string | null>('aiec-project', null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState<string | null>(null);

  const projects = usePoll((signal) => api.listProjects(signal), { intervalMs: 15_000 });
  const scope = selectedProjectId ?? undefined;

  const runs = usePoll((signal) => api.listRuns(scope, signal), { intervalMs: 4000 }, [scope]);
  const tasks = usePoll((signal) => api.listTasks(scope, signal), { intervalMs: 7000 }, [scope]);
  const messages = usePoll((signal) => api.messages(scope, signal), { intervalMs: 7000 }, [scope]);
  const agents = usePoll((signal) => api.listAgents(signal), { intervalMs: 60_000 });

  const projectList = projects.data?.projects ?? [];
  const allRuns = useMemo(() => runs.data?.runs ?? [], [runs.data]);
  const allTasks = useMemo(() => tasks.data?.tasks ?? [], [tasks.data]);

  const liveRuns = useMemo(() => allRuns.filter((r) => ACTIVE_RUN.has(r.status)), [allRuns]);
  const nodes = useWorkspaceNodes(liveRuns, allTasks);
  const flows = useFlows(messages.data?.messages ?? [], liveRuns.length > 0);
  const alerts = useMemo(() => buildAlerts(allRuns, allTasks), [allRuns, allTasks]);

  const dormant = projectList.length === 0;

  const onDispatch = useCallback((request: string) => {
    setDispatching(request);
    window.setTimeout(() => setDispatching(null), 2600);
  }, []);

  const selectedNode = nodes.find((n) => n.agentKey === selectedAgent);

  return (
    <>
      <WorkspaceCanvas
        nodes={nodes}
        flows={flows}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        incomingRequest={dispatching}
        dormant={dormant}
      />

      {dormant ? (
        <StandbyPrompt />
      ) : (
        <>
          <AnimatePresence>
            {alerts.length > 0 && !selectedAgent && <AlertStrip alerts={alerts} />}
          </AnimatePresence>

          <AnimatePresence>
            {selectedAgent && (
              <AgentInspector
                key={selectedAgent}
                agentKey={selectedAgent}
                state={selectedNode?.state ?? 'idle'}
                activity={selectedNode?.activity}
                agent={agents.data?.agents.find((a) => a.key === selectedAgent)}
                tasks={allTasks.filter((t) => t.assignedTo === selectedAgent)}
                onClose={() => setSelectedAgent(null)}
              />
            )}
          </AnimatePresence>

          <CommandConsole
            projects={projectList}
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            onDispatch={onDispatch}
          />
        </>
      )}
    </>
  );
}

/**
 * Collapse live runs and tasks into one state per agent.
 *
 * A station can show only one state, so the most urgent wins. The ranking is
 * deliberate: a blocked agent must never be hidden behind a running one, because
 * blocked is the state that needs a human and running is the state that does
 * not.
 */
function useWorkspaceNodes(liveRuns: WorkflowRun[], tasks: Task[]): WorkspaceNode[] {
  return useMemo(() => {
    const rank: Record<AgentState, number> = {
      blocked: 7,
      failed: 6,
      retrying: 5,
      running: 4,
      starting: 3,
      waiting: 2,
      queued: 1,
      completed: 0,
      cancelled: 0,
      idle: -1,
    };

    const byAgent = new Map<string, WorkspaceNode>();
    for (const identity of allAgentIdentities()) {
      byAgent.set(identity.key, { agentKey: identity.key, state: 'idle', queued: 0 });
    }

    const consider = (key: string, state: AgentState, activity?: string): void => {
      const existing = byAgent.get(key) ?? { agentKey: key, state: 'idle' as AgentState, queued: 0 };
      if (rank[existing.state] >= rank[state]) return;
      byAgent.set(key, { ...existing, state, activity });
    };

    for (const run of liveRuns) {
      const firstPending = run.steps.findIndex((s) => s.status === 'pending');
      run.steps.forEach((step, index) => {
        const state = stepState(step.status, {
          runActive: true,
          isNext: index === firstPending,
          attempt: step.attempt,
        });
        if (state !== 'idle') consider(step.agentKey, state, step.name);
      });
      consider(
        ORCHESTRATOR_KEY,
        run.status === 'awaiting_approval' ? 'blocked' : 'running',
        run.request.length > 46 ? `${run.request.slice(0, 45)}…` : run.request,
      );
    }

    for (const task of tasks) {
      if (!task.assignedTo) continue;
      const node = byAgent.get(task.assignedTo);
      if (node && !['done', 'cancelled'].includes(task.status)) {
        node.queued = (node.queued ?? 0) + 1;
      }
      const state = taskState(task.status);
      if (['blocked', 'running', 'waiting'].includes(state)) consider(task.assignedTo, state, task.title);
    }

    return [...byAgent.values()];
  }, [liveRuns, tasks]);
}

/** Recent messages become packets. Old ones do not — a packet means "now". */
function useFlows(messages: AgentMessage[], anyLive: boolean): WorkspaceFlow[] {
  return useMemo(() => {
    if (!anyLive) return [];
    const cutoff = Date.now() - 3 * 60 * 1000;
    return messages
      .filter((m) => new Date(m.createdAt).getTime() > cutoff)
      .slice(0, 6)
      .map((m) => ({ id: m._id, from: m.from, to: m.to, kind: flowKindForIntent(m.intent) }));
  }, [messages, anyLive]);
}

interface Alert {
  id: string;
  href: string;
  title: string;
  action: string;
  agentKey?: string;
  severity: 'blocked' | 'failed' | 'waiting';
}

function buildAlerts(runs: WorkflowRun[], tasks: Task[]): Alert[] {
  const alerts: Alert[] = [];

  for (const run of runs) {
    if (run.status === 'awaiting_approval') {
      const step = run.steps.find((s) => s.status === 'awaiting_approval');
      alerts.push({
        id: run._id,
        href: `/runs/${run._id}`,
        title: step?.name ?? run.workflow,
        action: 'Approve to continue',
        agentKey: step?.agentKey,
        severity: 'waiting',
      });
    } else if (run.status === 'interrupted') {
      alerts.push({
        id: run._id,
        href: `/runs/${run._id}`,
        title: run.workflow,
        action: 'Worker stopped — resume or cancel',
        severity: 'failed',
      });
    }
  }

  for (const task of tasks) {
    if (task.status === 'blocked') {
      alerts.push({
        id: task._id,
        href: task.workflowRunId ? `/runs/${task.workflowRunId}` : `/projects/${task.projectId}`,
        title: task.title,
        action: 'Agent cannot proceed',
        agentKey: task.assignedTo,
        severity: 'blocked',
      });
    }
  }

  const order = { blocked: 0, failed: 1, waiting: 2 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 4);
}

const ALERT_COLOR = {
  blocked: 'var(--status-serious)',
  failed: 'var(--status-critical)',
  waiting: 'var(--status-warning)',
};

/**
 * Work that has stopped and is waiting for a human.
 *
 * Anchored left, below the identity block, and present only when there is
 * something to say. The audit found attention items rendered as plain text with
 * no route to the thing needing attention; every row here goes straight to it.
 */
function AlertStrip({ alerts }: { alerts: Alert[] }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -12 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className="pointer-events-auto absolute left-5 top-20 z-20 w-[min(300px,calc(100vw-2.5rem))] space-y-1.5"
    >
      <p className="eyebrow pl-1">Waiting on you</p>
      <AnimatePresence initial={false}>
        {alerts.map((alert) => (
          <motion.div key={alert.id} layout initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Link
              href={alert.href}
              className="flex items-start gap-2.5 rounded-xl border p-2.5 backdrop-blur-md transition-colors hover:border-[var(--border-strong)]"
              style={{
                background: 'color-mix(in srgb, var(--surface-1) 88%, transparent)',
                borderColor: `color-mix(in srgb, ${ALERT_COLOR[alert.severity]} 30%, var(--border))`,
                boxShadow: 'var(--elev-2)',
              }}
            >
              {alert.agentKey ? (
                <AgentAvatar
                  agentKey={alert.agentKey}
                  state={alert.severity === 'waiting' ? 'blocked' : alert.severity}
                  size={30}
                  showMonogram={false}
                />
              ) : (
                <span aria-hidden className="mt-0.5 text-[13px]" style={{ color: ALERT_COLOR[alert.severity] }}>
                  ⚠
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium">{alert.title}</span>
                <span className="block text-[10.5px]" style={{ color: ALERT_COLOR[alert.severity] }}>
                  {alert.action} →
                </span>
              </span>
            </Link>
          </motion.div>
        ))}
      </AnimatePresence>
    </motion.div>
  );
}

/**
 * Standby: the room exists, the team is asleep, nothing is connected.
 *
 * The skill's rule for an empty multi-agent system is sleeping agents and a dim
 * network rather than a generic empty card — the interface should communicate
 * that the system is ready and waiting, not that it is broken or unbuilt.
 */
function StandbyPrompt() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25, duration: 0.5 }}
      className="pointer-events-auto absolute bottom-20 left-1/2 z-20 w-[min(560px,calc(100vw-2.5rem))] -translate-x-1/2 lg:bottom-8"
    >
      <div
        className="rounded-2xl border p-5 text-center backdrop-blur-md"
        style={{
          background: 'color-mix(in srgb, var(--surface-1) 90%, transparent)',
          boxShadow: 'var(--elev-3)',
        }}
      >
        <p className="eyebrow">Standby</p>
        <h1 className="mt-1.5 text-[16px] font-semibold tracking-tight">
          Six specialists, asleep at their stations
        </h1>
        <p className="mx-auto mt-2 max-w-md text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          They read your repository, plan a change, write it, verify it, and hand you a reviewable
          pull request. Connect a repository to wake them.
        </p>

        <div className="mt-4 flex items-center justify-center gap-3">
          <Link
            href="/projects"
            className="rounded-lg px-3.5 py-2 text-[12.5px] font-medium text-white"
            style={{ background: 'var(--series-1)' }}
          >
            Connect a repository
          </Link>
          <Link
            href="/org"
            className="text-[12px] hover:underline"
            style={{ color: 'var(--text-muted)' }}
          >
            What each role may touch →
          </Link>
        </div>

        <p className="mt-3.5 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Your code is cloned to this server and read by the model provider you configured. Files
          matching the secret policy — <code className="hud">.env</code>, keys, credentials — are
          excluded from indexing and from every prompt.
        </p>
      </div>
    </motion.div>
  );
}

/**
 * Run status → the visual state used on avatars and badges elsewhere.
 * Exported here because the run pages render the same vocabulary.
 */
export function runVisualState(run: WorkflowRun): AgentState {
  switch (run.status) {
    case 'running':
      return 'running';
    case 'queued':
    case 'pending':
      return 'queued';
    case 'cancelling':
      return 'cancelled';
    case 'awaiting_approval':
      return 'blocked';
    case 'completed':
      return run.outcome === 'needs_review' || run.outcome === 'blocked' ? 'waiting' : 'completed';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'retrying';
    case 'cancelled':
    default:
      return 'cancelled';
  }
}

/** Re-exported so other screens can label an agent consistently. */
export { agentIdentity };
