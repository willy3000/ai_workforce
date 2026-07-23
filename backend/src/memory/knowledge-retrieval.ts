import type { Types } from 'mongoose';
import {
  codeRepositoryRepository,
  decisionRepository,
  knowledgeRepository,
} from '../database/repositories';
import type { IKnowledge } from '../database/models/knowledge.model';
import type { IDecision } from '../database/models/decision.model';
import type { IFileIndexEntry } from '../database/models/repository.model';
import { extractKeywords } from '../utils/text';

/**
 * Retrieval, not stuffing.
 *
 * The core constraint of this platform: **we never send a repository to the
 * model.** For each task we assemble a small, targeted bundle:
 *
 *   - the project profile (always — it is what makes the agent write idiomatic code)
 *   - accepted architecture decisions (always — they are binding)
 *   - the top-N knowledge entries matching the task text
 *   - the top-N *file paths* (paths and summaries, not contents) that look relevant
 *
 * The agent then pulls file contents on demand through tools. That inverts the
 * usual failure mode: instead of a huge prompt that mostly isn't relevant, the
 * agent gets a map and fetches the territory it actually needs.
 */
export interface RetrievedContext {
  knowledge: IKnowledge[];
  decisions: IDecision[];
  files: IFileIndexEntry[];
  keywords: string[];
}

export interface RetrievalOptions {
  projectId: Types.ObjectId;
  query: string;
  knowledgeLimit?: number;
  fileLimit?: number;
  decisionLimit?: number;
}

export class KnowledgeRetrieval {
  async retrieve(options: RetrievalOptions): Promise<RetrievedContext> {
    const {
      projectId,
      query,
      knowledgeLimit = 8,
      fileLimit = 15,
      decisionLimit = 10,
    } = options;

    const keywords = extractKeywords(query);
    const mentionedPaths = this.extractPaths(query);

    const [knowledgeHits, decisions, fileIndex] = await Promise.all([
      knowledgeRepository.search({
        projectId,
        query,
        paths: mentionedPaths,
        limit: knowledgeLimit,
      }),
      decisionRepository.list(projectId, decisionLimit),
      codeRepositoryRepository.getFileIndex(projectId),
    ]);

    return {
      knowledge: knowledgeHits.map((h) => h.entry),
      decisions,
      files: this.rankFiles(fileIndex, keywords, mentionedPaths, fileLimit),
      keywords,
    };
  }

  /**
   * Rank indexed files against the task.
   *
   * Signals, in rough order of weight: an explicit path mention in the request,
   * a symbol-name match, a path-component match, a summary match, and a small
   * boost for architecturally important files (entry points, configs, schemas)
   * so an agent always has something to orient on even for a vague request.
   */
  private rankFiles(
    index: IFileIndexEntry[],
    keywords: string[],
    mentionedPaths: string[],
    limit: number,
  ): IFileIndexEntry[] {
    if (!index.length) return [];

    const scored = index.map((entry) => {
      const lowerPath = entry.path.toLowerCase();
      let score = 0;

      for (const mentioned of mentionedPaths) {
        if (lowerPath.includes(mentioned.toLowerCase())) score += 20;
      }
      for (const keyword of keywords) {
        if (lowerPath.includes(keyword)) score += 6;
        if (entry.symbols.some((s) => s.toLowerCase() === keyword)) score += 8;
        else if (entry.symbols.some((s) => s.toLowerCase().includes(keyword))) score += 3;
        if (entry.summary.toLowerCase().includes(keyword)) score += 2;
      }
      if (entry.important) score += 2;
      // Mild penalty for very large files: they are rarely the right entry point.
      if (entry.lines > 2000) score -= 1;

      return { entry, score };
    });

    const relevant = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

    // Vague request with no lexical hits — fall back to the important files so
    // the agent still receives a usable map of the project.
    if (relevant.length < 3) {
      const important = scored
        .filter((s) => s.entry.important)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      const merged = new Map(relevant.concat(important).map((s) => [s.entry.path, s]));
      return [...merged.values()].slice(0, limit).map((s) => s.entry);
    }

    return relevant.slice(0, limit).map((s) => s.entry);
  }

  /** Pull explicit file paths out of a free-form request. */
  private extractPaths(text: string): string[] {
    const matches = text.match(/[\w./-]+\.[a-zA-Z]{1,5}\b/g) ?? [];
    return [...new Set(matches.filter((m) => m.includes('/') || m.includes('.')))].slice(0, 10);
  }
}

export const knowledgeRetrieval = new KnowledgeRetrieval();
