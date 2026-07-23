import type {
  Agent, AgentMessage, AgentRunResult, MemorySnapshot, Project,
  ReadyState, RepositorySummary, Task, WorkflowDefinition, WorkflowRun,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });

  const text = await res.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`Malformed response from ${path}`, res.status);
  }

  if (!res.ok) {
    const err = (payload as { error?: { message?: string; code?: string; details?: unknown } }).error;
    throw new ApiError(
      err?.message ?? `Request failed (${res.status})`,
      res.status,
      err?.code,
      err?.details,
    );
  }
  return payload as T;
}

const get = <T>(p: string) => request<T>(p);
const post = <T>(p: string, body?: unknown) =>
  request<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = <T>(p: string, body: unknown) =>
  request<T>(p, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(p: string) => request<T>(p, { method: 'DELETE' });

export const api = {
  // --- platform ---
  ready: () => get<ReadyState>('/health/ready'),

  // --- projects ---
  listProjects: () => get<{ projects: Project[]; count: number }>('/projects'),
  getProject: (id: string) =>
    get<{ project: Project; repository: RepositorySummary | null }>(`/projects/${id}`),
  connectProject: (body: {
    repositoryUrl?: string;
    localPath?: string;
    name?: string;
    branch?: string;
    customInstructions?: string;
  }) => post<{ project: Project }>('/projects/connect', body),
  reanalyze: (id: string) => post<{ project: Project }>(`/projects/${id}/reanalyze`),
  memory: (id: string) => get<MemorySnapshot>(`/projects/${id}/memory`),
  setInstructions: (id: string, customInstructions: string) =>
    patch<{ project: Project }>(`/projects/${id}/instructions`, { customInstructions }),
  disconnect: (id: string) => del<void>(`/projects/${id}?confirm=true`),

  // --- agents ---
  listAgents: () => get<{ agents: Agent[] }>('/agents'),
  runAgent: (body: { agentKey: string; projectId: string; prompt: string }) =>
    post<{ result: AgentRunResult }>('/agents/run', body),
  messages: (projectId?: string) =>
    get<{ messages: AgentMessage[]; count: number }>(
      `/agents/messages${projectId ? `?projectId=${projectId}` : ''}`,
    ),
  sendMessage: (body: { projectId: string; to: string; message: string; intent?: string }) =>
    post<{ ok: boolean }>('/agents/messages', body),
  route: (body: { title: string; description?: string; type?: string }) =>
    post<{ routing: { agentKey: string; confidence: number; reason: string }; candidates: { agentKey: string; score: number }[] }>(
      '/agents/route',
      body,
    ),

  // --- tasks ---
  listTasks: (projectId?: string) =>
    get<{ tasks: Task[]; count: number }>(`/tasks${projectId ? `?projectId=${projectId}` : ''}`),
  getTask: (id: string) => get<{ task: Task; messages: AgentMessage[] }>(`/tasks/${id}`),
  createTask: (body: Record<string, unknown>) =>
    post<{ task: Task; result?: AgentRunResult }>('/tasks', body),
  runTask: (id: string) => post<{ task: Task; result: AgentRunResult }>(`/tasks/${id}/run`),
  approveTask: (id: string) => post<{ task: Task }>(`/tasks/${id}/approve`),
  setTaskStatus: (id: string, status: string, note = '') =>
    post<{ task: Task }>(`/tasks/${id}/status`, { status, note }),

  // --- workflows ---
  listWorkflows: () => get<{ workflows: WorkflowDefinition[] }>('/workflows'),
  startWorkflow: (body: { projectId: string; workflow: string; request: string; autoRun?: boolean }) =>
    post<{ run: WorkflowRun }>('/workflows/run', body),
  listRuns: (projectId?: string) =>
    get<{ runs: WorkflowRun[]; count: number }>(
      `/workflows/runs${projectId ? `?projectId=${projectId}` : ''}`,
    ),
  getRun: (id: string) => get<{ run: WorkflowRun; tasks: Task[] }>(`/workflows/runs/${id}`),
  approveStep: (id: string, stepId: string) =>
    post<{ run: WorkflowRun }>(`/workflows/runs/${id}/approve`, { stepId }),
  resumeRun: (id: string) => post<{ run: WorkflowRun }>(`/workflows/runs/${id}/resume`),
  cancelRun: (id: string) => post<{ ok: boolean }>(`/workflows/runs/${id}/cancel`),
};
