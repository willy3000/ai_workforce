import type {
  Agent, AgentMessage, AgentRunResult, MemorySnapshot, Project,
  ReadyState, RepositorySummary, Task, WorkflowDefinition, WorkflowRun, WorkforceSettings,
} from './types';

/** All browser traffic goes through the server-side gateway (see app/api/gateway). */
const BASE = '/api/gateway';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiUnauthenticatedError extends ApiError {
  constructor(message: string) {
    super(message, 401, 'unauthenticated');
    this.name = 'ApiUnauthenticatedError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });

  // A 204 has no body by definition; parsing one produces a spurious error on a
  // request that actually succeeded (the DELETE case from the audit).
  if (res.status === 204 || res.status === 205) return null as T;

  const text = await res.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`Malformed response from ${path}`, res.status);
  }

  if (!res.ok) {
    const err = (payload as { error?: { message?: string; code?: string; details?: unknown } }).error;
    const message = err?.message ?? `Request failed (${res.status})`;
    // Distinguished so the shell can redirect to sign-in instead of rendering
    // "Request failed (401)" in every panel at once.
    if (res.status === 401) throw new ApiUnauthenticatedError(message);
    throw new ApiError(message, res.status, err?.code, err?.details);
  }
  return payload as T;
}

/**
 * Every read accepts an `AbortSignal` so `usePoll` can cancel in-flight work
 * when the screen changes or a newer poll starts.
 */
const get = <T>(p: string, signal?: AbortSignal) => request<T>(p, { signal });
const post = <T>(p: string, body?: unknown) =>
  request<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = <T>(p: string, body: unknown) =>
  request<T>(p, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(p: string) => request<T>(p, { method: 'DELETE' });

export const api = {
  // --- session ---
  /** Exchange the operator password for a session cookie. */
  signIn: async (password: string): Promise<void> => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; code?: string };
      };
      throw new ApiError(payload.error?.message ?? 'Sign-in failed', res.status, payload.error?.code);
    }
  },
  signOut: async (): Promise<void> => {
    await fetch('/api/auth/login', { method: 'DELETE' });
  },

  // --- platform ---
  ready: (signal?: AbortSignal) => get<ReadyState>('/health/ready', signal),
  getSettings: (signal?: AbortSignal) => get<{ settings: WorkforceSettings }>('/settings', signal),
  updateSettings: (settings: WorkforceSettings) =>
    patch<{ settings: WorkforceSettings }>('/settings', settings),

  // --- projects ---
  listProjects: (signal?: AbortSignal) =>
    get<{ projects: Project[]; count: number }>('/projects', signal),
  getProject: (id: string, signal?: AbortSignal) =>
    get<{ project: Project; repository: RepositorySummary | null }>(`/projects/${id}`, signal),
  connectProject: (body: {
    repositoryUrl?: string;
    localPath?: string;
    name?: string;
    branch?: string;
    customInstructions?: string;
  }) => post<{ project: Project }>('/projects/connect', body),
  reanalyze: (id: string) => post<{ project: Project }>(`/projects/${id}/reanalyze`),
  memory: (id: string, signal?: AbortSignal) => get<MemorySnapshot>(`/projects/${id}/memory`, signal),
  setInstructions: (id: string, customInstructions: string) =>
    patch<{ project: Project }>(`/projects/${id}/instructions`, { customInstructions }),
  disconnect: (id: string) => del<void>(`/projects/${id}?confirm=true`),

  // --- agents ---
  listAgents: (signal?: AbortSignal) => get<{ agents: Agent[] }>('/agents', signal),
  runAgent: (body: { agentKey: string; projectId: string; prompt: string }) =>
    post<{ result: AgentRunResult; taskId?: string }>('/agents/run', body),
  messages: (projectId?: string, signal?: AbortSignal) =>
    get<{ messages: AgentMessage[]; count: number }>(
      `/agents/messages${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      signal,
    ),
  sendMessage: (body: { projectId: string; to: string; message: string; intent?: string }) =>
    post<{ ok: boolean }>('/agents/messages', body),
  route: (body: { title: string; description?: string; type?: string }) =>
    post<{ routing: { agentKey: string; confidence: number; reason: string }; candidates: { agentKey: string; score: number }[] }>(
      '/agents/route',
      body,
    ),

  // --- tasks ---
  listTasks: (projectId?: string, signal?: AbortSignal) =>
    get<{ tasks: Task[]; count: number }>(
      `/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      signal,
    ),
  getTask: (id: string, signal?: AbortSignal) =>
    get<{ task: Task; messages: AgentMessage[] }>(`/tasks/${id}`, signal),
  createTask: (body: Record<string, unknown>) =>
    post<{ task: Task; result?: AgentRunResult }>('/tasks', body),
  runTask: (id: string) => post<{ task: Task; result: AgentRunResult }>(`/tasks/${id}/run`),
  approveTask: (id: string) => post<{ task: Task }>(`/tasks/${id}/approve`),
  setTaskStatus: (id: string, status: string, note = '') =>
    post<{ task: Task }>(`/tasks/${id}/status`, { status, note }),

  // --- workflows ---
  listWorkflows: (signal?: AbortSignal) =>
    get<{ workflows: WorkflowDefinition[] }>('/workflows', signal),
  /**
   * Returns 202 with a queued run — execution happens in the background, so the
   * caller navigates to the run immediately rather than awaiting completion.
   */
  startWorkflow: (body: { projectId: string; workflow: string; request: string; autoRun?: boolean }) =>
    post<{ run: WorkflowRun; message: string }>('/workflows/run', body),
  listRuns: (projectId?: string, signal?: AbortSignal) =>
    get<{ runs: WorkflowRun[]; count: number }>(
      `/workflows/runs${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      signal,
    ),
  getRun: (id: string, signal?: AbortSignal) =>
    get<{ run: WorkflowRun; tasks: Task[] }>(`/workflows/runs/${id}`, signal),
  approveStep: (id: string, stepId: string) =>
    post<{ run: WorkflowRun; message: string }>(`/workflows/runs/${id}/approve`, { stepId }),
  resumeRun: (id: string) => post<{ run: WorkflowRun; message: string }>(`/workflows/runs/${id}/resume`),
  /** Answers `cancelling` (worker is stopping) or `cancelled` (nothing was running). */
  cancelRun: (id: string, reason?: string) =>
    post<{ status: 'cancelled' | 'cancelling'; message: string; run: WorkflowRun }>(
      `/workflows/runs/${id}/cancel`,
      reason ? { reason } : {},
    ),
};
