import type { Types } from 'mongoose';
import { knowledgeRetrieval } from './knowledge-retrieval';
import { messageRepository, taskRepository } from '../database/repositories';
import type { IProject } from '../database/models/project.model';
import type { ITask } from '../database/models/task.model';
import type { AgentDefinition } from '../agents/types';
import { truncate } from '../utils/text';

/**
 * Prompt assembly.
 *
 * The split between `system` and `user` here is deliberate and load-bearing for
 * cost: the system prompt contains only content that is **stable across every
 * step of a workflow** (agent instructions + project profile + operator
 * overrides), so it is served from the prompt cache from the second call
 * onwards. Everything task-specific goes in the user message, where changing it
 * costs nothing extra.
 *
 * Ordering inside the user message is also intentional — retrieved context
 * first, the actual instruction last — so the instruction is the most recent
 * thing the model reads.
 */
export interface BuiltContext {
  system: string;
  user: string;
}

export class ContextBuilder {
  buildSystemPrompt(agent: AgentDefinition, project: IProject): string {
    const p = project.profile;
    const sections: string[] = [agent.instructions];

    sections.push(`
# Project: ${p.projectName || project.name}
You are operating on a real, existing codebase. Everything below was detected by
analysing the repository — treat it as fact and write code that fits it.

- Languages:        ${p.languages.join(', ') || 'unknown'}
- Frameworks:       ${p.frameworks.join(', ') || 'none detected'}
- Architecture:     ${p.architecture}
- Database:         ${p.database}
- Testing:          ${p.testingFramework}
- Deployment:       ${p.deployment}
- Package managers: ${p.packageManagers.join(', ') || 'unknown'}
${p.buildCommand ? `- Build command:    ${p.buildCommand}` : ''}
${p.testCommand ? `- Test command:     ${p.testCommand}` : ''}
${p.entryPoints.length ? `- Entry points:     ${p.entryPoints.join(', ')}` : ''}

## Conventions detected in this repository
${p.conventions.length ? p.conventions.map((c) => `- ${c}`).join('\n') : '- (none detected — infer from neighbouring files)'}
`);

    if (project.customInstructions?.trim()) {
      sections.push(`# Operator instructions for this project\n${project.customInstructions.trim()}`);
    }

    sections.push(`
# How you operate
- You see the repository through tools, not as a dump. Search, then read only what you need.
- Paths are repository-relative. Your write scope is enforced by the platform: a write outside it is rejected, not silently applied.
- Never read or write secrets (.env, keys, credentials). They are blocked and attempting them is a defect in your reasoning.
- Report outcomes faithfully. If a command failed, say so with its output. Do not claim you verified something you did not run.
- Finish with report_completion. Do not end your turn with a plan or a promise of work you have not done.
`);

    return sections.join('\n');
  }

  /**
   * Assemble the task-specific message: retrieved memory + repository map +
   * dependency results + inbox + the instruction itself.
   */
  async buildUserMessage(params: {
    projectId: Types.ObjectId;
    agentKey: string;
    prompt: string;
    task?: ITask;
    additionalContext?: string;
  }): Promise<string> {
    const { projectId, agentKey, prompt, task, additionalContext } = params;
    const query = [task?.title, task?.description, prompt].filter(Boolean).join('\n');

    const [retrieved, inbox] = await Promise.all([
      knowledgeRetrieval.retrieve({ projectId, query }),
      messageRepository.list({ projectId, to: agentKey, unreadOnly: true }, 10),
    ]);

    const parts: string[] = [];

    if (retrieved.decisions.length) {
      parts.push(
        `# Binding architecture decisions\nThese are accepted and you must not contradict them.\n\n` +
          retrieved.decisions
            .map((d) => `- **${d.title}** — ${d.decision}\n  Rationale: ${truncate(d.rationale, 400)}`)
            .join('\n'),
      );
    }

    if (retrieved.knowledge.length) {
      parts.push(
        `# Relevant project memory\n` +
          retrieved.knowledge
            .map((k) => `## [${k.kind}] ${k.title}\n${truncate(k.content, 900)}`)
            .join('\n\n'),
      );
    }

    if (retrieved.files.length) {
      parts.push(
        `# Repository files likely relevant to this task\n` +
          `(This is a shortlist from the project index, not the full repository. ` +
          `Use read_file / code_search to explore further.)\n\n` +
          retrieved.files
            .map(
              (f) =>
                `- \`${f.path}\` (${f.language}, ${f.lines} lines)` +
                (f.symbols.length ? ` — ${f.symbols.slice(0, 6).join(', ')}` : '') +
                (f.summary ? `\n    ${truncate(f.summary, 160).replace(/\n/g, ' ')}` : ''),
            )
            .join('\n'),
      );
    }

    if (task) {
      const dependencies = await this.dependencyResults(task);
      if (dependencies) parts.push(dependencies);

      parts.push(
        `# Your task\n` +
          `**${task.title}**\n\n${task.description}\n` +
          (task.acceptanceCriteria.length
            ? `\n## Acceptance criteria\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`
            : '') +
          (task.attempts > 0
            ? `\n\n⚠️ This is attempt ${task.attempts + 1}. A previous attempt did not satisfy the criteria` +
              (task.error ? `: ${truncate(task.error, 600)}` : '.')
            : ''),
      );
    }

    if (inbox.length) {
      parts.push(
        `# Messages addressed to you\n` +
          inbox
            .map((m) => `- from **${m.from}** (${m.intent}): ${truncate(m.message, 700)}`)
            .join('\n'),
      );
      await messageRepository.markRead(inbox.map((m) => m._id));
    }

    if (additionalContext?.trim()) {
      parts.push(`# Context from earlier workflow steps\n${additionalContext.trim()}`);
    }

    // The instruction goes last: it is what the model should act on.
    parts.push(`# Instruction\n${prompt}`);

    return parts.join('\n\n---\n\n');
  }

  /** Outputs of the tasks this one depends on — the handoff payload. */
  private async dependencyResults(task: ITask): Promise<string | null> {
    if (!task.dependsOn.length) return null;
    const deps = await Promise.all(task.dependsOn.map((id) => taskRepository.findById(id)));
    const withResults = deps.filter((d) => d?.result);
    if (!withResults.length) return null;

    return (
      `# Results of the work this task depends on\n` +
      withResults
        .map((d) => `## ${d!.title} (by ${d!.assignedTo ?? 'unknown'})\n${truncate(d!.result!, 2500)}`)
        .join('\n\n')
    );
  }
}

export const contextBuilder = new ContextBuilder();
