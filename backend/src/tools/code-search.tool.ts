import { defineTool, type ToolResult } from './types';
import { PermissionGuard } from './permission-guard';
import { redactSecrets } from '../security/secret-paths';
import { codeRepositoryRepository } from '../database/repositories';

interface SearchInput {
  pattern: string;
  regex?: boolean;
  path_filter?: string;
  case_sensitive?: boolean;
  max_results?: number;
}

/**
 * Content search across the checkout.
 *
 * This tool exists so agents can *locate* code instead of being handed the
 * repository. It is the workhorse of the retrieval strategy: the agent gets a
 * ranked shortlist of `path:line` hits and then reads only those files.
 */
export const codeSearchTool = defineTool<SearchInput>({
  name: 'code_search',
  description:
    'Search the repository contents for a string or regular expression. Returns matching ' +
    'file paths with line numbers. Use this to find where something is implemented before ' +
    'reading files. Prefer a distinctive identifier over a generic word.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text or regular expression to search for' },
      regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default false)' },
      path_filter: { type: 'string', description: 'Only search paths containing this substring' },
      case_sensitive: { type: 'boolean', description: 'Case-sensitive match (default false)' },
      max_results: { type: 'integer', description: 'Maximum hits to return (default 60)' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const hits = await ctx.workspace.search(input.pattern, {
      regex: input.regex,
      pathFilter: input.path_filter,
      caseSensitive: input.case_sensitive,
      maxResults: Math.min(input.max_results ?? 60, 200),
    });

    // Filter results through the agent's read scope so search cannot be used to
    // exfiltrate the contents of files the agent may not read.
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey, ctx.packages);
    const visible = hits.filter((hit) => guard.canRead(hit.path));

    if (!visible.length) {
      return { output: `No matches for '${input.pattern}' within this agent's readable scope.` };
    }
    return {
      output: redactSecrets(visible.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')),
      data: { matches: visible.length },
    };
  },
});

interface FindFilesInput {
  query: string;
  limit?: number;
}

/**
 * Path/symbol lookup served from the persisted file index rather than the disk.
 * Cheap enough to call repeatedly, and it works even when the checkout is large.
 */
export const findFilesTool = defineTool<FindFilesInput>({
  name: 'find_files',
  description:
    'Find files by path fragment, filename, or exported symbol name using the pre-built ' +
    'project index. Faster than code_search for "where does X live?" questions.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Path fragment, file name, or symbol name' },
      limit: { type: 'integer', description: 'Maximum results (default 25)' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const index = await codeRepositoryRepository.getFileIndex(ctx.projectId);
    const needle = input.query.toLowerCase();
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey, ctx.packages);

    const scored = index
      .map((entry) => {
        let score = 0;
        const lowerPath = entry.path.toLowerCase();
        if (lowerPath.includes(needle)) score += 5;
        if (lowerPath.endsWith(needle)) score += 5;
        if (entry.symbols.some((s) => s.toLowerCase() === needle)) score += 8;
        if (entry.symbols.some((s) => s.toLowerCase().includes(needle))) score += 3;
        if (entry.summary.toLowerCase().includes(needle)) score += 1;
        if (entry.important) score += 1;
        return { entry, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .filter((r) => guard.canRead(r.entry.path))
      .slice(0, Math.min(input.limit ?? 25, 100));

    if (!scored.length) {
      return { output: `No indexed files match '${input.query}'.` };
    }
    return {
      output: scored
        .map(
          ({ entry }) =>
            `${entry.path} (${entry.language}, ${entry.lines} lines)` +
            (entry.symbols.length ? `\n    symbols: ${entry.symbols.slice(0, 8).join(', ')}` : ''),
        )
        .join('\n'),
      data: { matches: scored.length },
    };
  },
});
