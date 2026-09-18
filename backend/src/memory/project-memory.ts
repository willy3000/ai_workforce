import { Types } from 'mongoose';
import {
  decisionRepository,
  knowledgeRepository,
  taskRepository,
} from '../database/repositories';
import type { IKnowledge, KnowledgeKind } from '../database/models/knowledge.model';
import type { IProjectProfile } from '../database/models/project.model';

/**
 * The write side of long-term memory.
 *
 * Onboarding seeds it from static analysis; agents extend it during runs. The
 * key property is that memory is *project-scoped and durable* — a fact learned
 * during a bug fix in March is available to a feature agent in June without any
 * human re-explaining it.
 */
export class ProjectMemory {
  /** Seed memory from an onboarding analysis. Idempotent (upserts by title). */
  async seedFromProfile(
    projectId: Types.ObjectId,
    profile: IProjectProfile,
    important: { path: string; reason: string }[],
  ): Promise<number> {
    const entries: Partial<IKnowledge>[] = [
      {
        kind: 'architecture',
        title: 'Detected technology stack',
        content:
          `Languages: ${profile.languages.join(', ') || 'unknown'}. ` +
          `Frameworks: ${profile.frameworks.join(', ') || 'none'}. ` +
          `Database: ${profile.database}. Architecture style: ${profile.architecture}. ` +
          `Deployment: ${profile.deployment}.`,
        tags: [...profile.languages, ...profile.frameworks].map((t) => t.toLowerCase()),
        confidence: 0.9,
      },
      {
        kind: 'convention',
        title: 'Repository conventions',
        content: profile.conventions.length
          ? profile.conventions.join('\n')
          : 'No explicit tooling conventions detected; infer style from neighbouring files.',
        tags: ['conventions', 'style'],
        confidence: 0.75,
      },
      {
        kind: 'structure',
        title: 'Build and test commands',
        content:
          `Build: ${profile.buildCommand ?? 'unknown'}\n` +
          `Test: ${profile.testCommand ?? 'unknown'}\n` +
          `Testing framework: ${profile.testingFramework}\n` +
          `Package managers: ${profile.packageManagers.join(', ') || 'unknown'}`,
        tags: ['build', 'test', 'commands'],
        confidence: 0.85,
      },
    ];

    for (const file of important) {
      entries.push({
        kind: 'important_file',
        title: `Key file: ${file.path}`,
        content: file.reason,
        tags: ['structure', 'entrypoint'],
        paths: [file.path],
        confidence: 0.8,
      });
    }

    await Promise.all(
      entries.map((entry) =>
        knowledgeRepository.upsert({
          projectId,
          kind: entry.kind as KnowledgeKind,
          title: entry.title as string,
          content: entry.content,
          tags: entry.tags ?? [],
          paths: entry.paths ?? [],
          source: 'onboarding',
          confidence: entry.confidence ?? 0.8,
        }),
      ),
    );

    return entries.length;
  }

  /**
   * Record what a completed task actually changed.
   *
   * This is what gives the organization continuity: the next agent asking
   * "how is auth handled here?" retrieves the change record from the run that
   * built it, not just the code.
   */
  async recordChange(params: {
    projectId: Types.ObjectId;
    taskId: Types.ObjectId;
    agentKey: string;
    title: string;
    summary: string;
    paths: string[];
  }): Promise<void> {
    await knowledgeRepository.upsert({
      projectId: params.projectId,
      kind: 'change',
      title: params.title,
      content: params.summary,
      tags: ['change', params.agentKey],
      paths: params.paths,
      source: params.agentKey,
      taskId: params.taskId,
      confidence: 0.9,
    });
  }

  async recordIssue(params: {
    projectId: Types.ObjectId;
    title: string;
    content: string;
    paths?: string[];
    source: string;
  }): Promise<void> {
    await knowledgeRepository.upsert({
      projectId: params.projectId,
      kind: 'known_issue',
      title: params.title,
      content: params.content,
      paths: params.paths ?? [],
      tags: ['issue', 'risk'],
      source: params.source,
      confidence: 0.7,
    });
  }

  /** Operator-facing snapshot of everything the platform knows about a project. */
  async snapshot(projectId: string | Types.ObjectId) {
    const oid = new Types.ObjectId(String(projectId));
    const [knowledge, decisions, knowledgeCounts, taskCounts] = await Promise.all([
      knowledgeRepository.list(oid, undefined, 200),
      decisionRepository.list(oid, 50),
      knowledgeRepository.countByKind(oid),
      taskRepository.countByStatus(oid),
    ]);

    return {
      counts: { knowledge: knowledgeCounts, tasks: taskCounts, decisions: decisions.length },
      decisions: decisions.map((d) => ({
        id: d._id.toString(),
        title: d.title,
        decision: d.decision,
        rationale: d.rationale,
        status: d.status,
        decidedBy: d.decidedBy,
        createdAt: d.createdAt,
      })),
      knowledge: knowledge.map((k) => ({
        id: k._id.toString(),
        kind: k.kind,
        title: k.title,
        content: k.content,
        tags: k.tags,
        paths: k.paths,
        source: k.source,
        confidence: k.confidence,
        updatedAt: k.updatedAt,
      })),
    };
  }
}

export const projectMemory = new ProjectMemory();
