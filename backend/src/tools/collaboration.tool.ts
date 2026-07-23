import { defineTool, type ToolResult } from './types';
import { messageRepository, taskRepository } from '../database/repositories';
import { agentRegistry } from '../agents/registry';
import { ToolExecutionError } from '../utils/errors';
import type { TaskPriority, TaskType } from '../database/models/task.model';

const TASK_TYPES: TaskType[] = [
  'analysis', 'planning', 'architecture', 'backend', 'frontend',
  'testing', 'review', 'documentation', 'bugfix', 'devops',
];

interface CreateTaskInput {
  title: string;
  description: string;
  type: TaskType;
  assign_to?: string;
  priority?: TaskPriority;
  acceptance_criteria?: string[];
  depends_on?: string[];
}

/**
 * Task creation — the Project Manager's primary lever.
 *
 * Note that the agent supplies acceptance criteria. Those criteria are injected
 * into the assignee's prompt and are what the QA Engineer reviews against, so a
 * vague breakdown surfaces as a failed review rather than as silent drift.
 */
export const createTaskTool = defineTool<CreateTaskInput>({
  name: 'create_task',
  description:
    'Create a task and assign it to a specialist agent. Break work down so each task is ' +
    'owned by exactly one role and has concrete, checkable acceptance criteria. Use ' +
    'depends_on with previously returned task ids to express ordering.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short imperative title' },
      description: {
        type: 'string',
        description: 'What must be done, with enough detail for the assignee to start',
      },
      type: { type: 'string', enum: TASK_TYPES, description: 'Task category' },
      assign_to: {
        type: 'string',
        description: 'Agent key, e.g. backend-engineer. Omit to let the router decide.',
      },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      acceptance_criteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Objective, verifiable completion conditions',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task ids that must complete first',
      },
    },
    required: ['title', 'description', 'type'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (input.assign_to && !agentRegistry.has(input.assign_to)) {
      throw new ToolExecutionError(
        `Unknown agent '${input.assign_to}'. Available: ${agentRegistry.keys().join(', ')}`,
      );
    }

    const task = await taskRepository.create({
      projectId: ctx.projectId,
      workflowRunId: ctx.workflowRunId,
      title: input.title,
      description: input.description,
      type: input.type,
      status: 'backlog',
      priority: input.priority ?? 'medium',
      assignedTo: input.assign_to,
      createdBy: ctx.agentKey,
      acceptanceCriteria: input.acceptance_criteria ?? [],
      dependsOn: [],
    });

    return {
      output:
        `Created task ${task._id.toString()} — "${task.title}"` +
        (input.assign_to ? ` assigned to ${input.assign_to}.` : ' (unassigned).'),
      data: { taskId: task._id.toString() },
    };
  },
});

interface SendMessageInput {
  to: string;
  intent: 'question' | 'clarification' | 'review_request' | 'status' | 'handoff' | 'escalation';
  message: string;
}

/**
 * Inter-agent messaging.
 *
 * Messages are persisted, addressed, and delivered by the coordinator on the
 * recipient's next run — agents do not block waiting for a reply. `escalation`
 * addressed to `human` is the defined path for "I need a decision I am not
 * authorised to make".
 */
export const sendMessageTool = defineTool<SendMessageInput>({
  name: 'send_message',
  description:
    'Send a message to another agent or to the human operator ("human"). Use this to ask ' +
    'for clarification, request a review, hand off work, or escalate a decision that is ' +
    'outside your authority. The recipient sees it on their next turn.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient agent key, or "human"' },
      intent: {
        type: 'string',
        enum: ['question', 'clarification', 'review_request', 'status', 'handoff', 'escalation'],
      },
      message: { type: 'string', description: 'The message body' },
    },
    required: ['to', 'intent', 'message'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (input.to !== 'human' && input.to !== 'orchestrator' && !agentRegistry.has(input.to)) {
      throw new ToolExecutionError(
        `Unknown recipient '${input.to}'. Valid: human, ${agentRegistry.keys().join(', ')}`,
      );
    }

    await messageRepository.create({
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      workflowRunId: ctx.workflowRunId,
      from: ctx.agentKey,
      to: input.to,
      intent: input.intent,
      message: input.message,
    });

    return { output: `Message delivered to ${input.to} (${input.intent}).` };
  },
});

interface ReportInput {
  summary: string;
  status: 'completed' | 'blocked' | 'needs_review';
  details?: string;
}

/** Explicit completion report — the structured end-of-task signal. */
export const reportCompletionTool = defineTool<ReportInput>({
  name: 'report_completion',
  description:
    'Report the outcome of your task. Call this exactly once, as your final action. State ' +
    'plainly what you did, what you verified, and anything you deliberately did not do.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One-paragraph outcome summary' },
      status: { type: 'string', enum: ['completed', 'blocked', 'needs_review'] },
      details: { type: 'string', description: 'Files touched, commands run, results observed' },
    },
    required: ['summary', 'status'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    await messageRepository.create({
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      workflowRunId: ctx.workflowRunId,
      from: ctx.agentKey,
      to: 'project-manager',
      intent: 'completion',
      message: input.summary,
      payload: { status: input.status, details: input.details },
    });
    await ctx.recordArtifact({
      type: 'note',
      content: `[${input.status}] ${input.summary}\n${input.details ?? ''}`,
    });
    return {
      output: `Completion reported (${input.status}).`,
      data: { status: input.status, summary: input.summary },
    };
  },
});
