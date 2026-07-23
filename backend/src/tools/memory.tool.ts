import { defineTool, type ToolResult } from './types';
import { knowledgeRepository, decisionRepository } from '../database/repositories';
import type { KnowledgeKind } from '../database/models/knowledge.model';

const KNOWLEDGE_KINDS: KnowledgeKind[] = [
  'architecture', 'convention', 'change', 'structure',
  'important_file', 'known_issue', 'domain', 'requirement',
];

interface RecallInput {
  query: string;
  kind?: KnowledgeKind;
  limit?: number;
}

/**
 * Explicit recall from long-term project memory.
 *
 * The context builder already front-loads the most relevant memories into the
 * prompt. This tool exists for the second-order case: the agent discovers
 * mid-task that it needs to know something about an area it wasn't given
 * (e.g. it opens the auth module and wants the prior decisions about sessions).
 */
export const recallMemoryTool = defineTool<RecallInput>({
  name: 'recall_project_memory',
  description:
    'Search the long-term project memory for architecture decisions, coding conventions, ' +
    'previous changes, known issues and domain facts. Use this when you need background ' +
    'that was not included in your initial context.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What you want to know about' },
      kind: { type: 'string', enum: KNOWLEDGE_KINDS, description: 'Optional category filter' },
      limit: { type: 'integer', description: 'Maximum entries (default 6)' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const hits = await knowledgeRepository.search({
      projectId: ctx.projectId,
      query: input.query,
      kinds: input.kind ? [input.kind] : undefined,
      limit: Math.min(input.limit ?? 6, 20),
    });

    if (!hits.length) return { output: `No stored memory matches '${input.query}'.` };
    return {
      output: hits
        .map(({ entry }) => `[${entry.kind}] ${entry.title}\n${entry.content}`)
        .join('\n\n'),
      data: { count: hits.length },
    };
  },
});

interface RememberInput {
  kind: KnowledgeKind;
  title: string;
  content: string;
  tags?: string[];
  paths?: string[];
}

/**
 * Write to long-term memory.
 *
 * This is how the organization accumulates institutional knowledge across runs:
 * an agent that discovers a convention, a landmine, or a structural fact records
 * it once and every future agent on the project gets it via retrieval.
 */
export const rememberTool = defineTool<RememberInput>({
  name: 'remember',
  description:
    'Store a durable fact about this project in long-term memory so future agents inherit ' +
    'it. Record conventions, non-obvious structure, gotchas, and what you changed. Do not ' +
    'record transient chatter or anything already obvious from reading the code.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: KNOWLEDGE_KINDS, description: 'Category of the fact' },
      title: { type: 'string', description: 'Short, specific title' },
      content: { type: 'string', description: 'The fact itself, plus why it matters' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Search tags' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Repository paths this fact concerns',
      },
    },
    required: ['kind', 'title', 'content'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    await knowledgeRepository.upsert({
      projectId: ctx.projectId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      paths: input.paths ?? [],
      source: ctx.agentKey,
      taskId: ctx.taskId,
      confidence: 0.85,
    });
    return { output: `Stored in project memory: [${input.kind}] ${input.title}` };
  },
});

interface DecisionInput {
  title: string;
  context: string;
  decision: string;
  rationale: string;
  alternatives?: string[];
  consequences?: string[];
}

/**
 * Record an Architecture Decision Record.
 *
 * Restricted (by tool assignment) to the Engineering Manager: architecture is a
 * single-owner concern, and letting every engineer record binding decisions is
 * how a codebase ends up with three competing patterns.
 */
export const recordDecisionTool = defineTool<DecisionInput>({
  name: 'record_decision',
  description:
    'Record a binding architecture decision (an ADR) for this project. Future agents are ' +
    'required to follow accepted decisions. Include the alternatives you rejected and why.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Decision title' },
      context: { type: 'string', description: 'The situation that forced a decision' },
      decision: { type: 'string', description: 'What was decided' },
      rationale: { type: 'string', description: 'Why this option won' },
      alternatives: { type: 'array', items: { type: 'string' }, description: 'Rejected options' },
      consequences: {
        type: 'array',
        items: { type: 'string' },
        description: 'What this commits the project to',
      },
    },
    required: ['title', 'context', 'decision', 'rationale'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const decision = await decisionRepository.create({
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      title: input.title,
      context: input.context,
      decision: input.decision,
      rationale: input.rationale,
      alternatives: input.alternatives ?? [],
      consequences: input.consequences ?? [],
      status: 'accepted',
      decidedBy: ctx.agentKey,
    });

    // Mirrored into knowledge so keyword retrieval can surface it too.
    await knowledgeRepository.upsert({
      projectId: ctx.projectId,
      kind: 'architecture',
      title: `ADR: ${input.title}`,
      content: `${input.decision}\n\nRationale: ${input.rationale}`,
      tags: ['adr', 'architecture'],
      source: ctx.agentKey,
      confidence: 1,
    });

    return {
      output: `Recorded decision '${input.title}' (${decision._id.toString()}).`,
      data: { decisionId: decision._id.toString() },
    };
  },
});
