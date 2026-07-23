import { defineTool, type ToolContext, type ToolResult } from './types';
import { PermissionGuard } from './permission-guard';
import { truncate } from '../utils/text';

interface ReadInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

/** Read a single file (or line range) from the project checkout. */
export const repositoryReaderTool = defineTool<ReadInput>({
  name: 'read_file',
  description:
    'Read the contents of a file in the connected repository. Paths are relative to the ' +
    'repository root (e.g. "src/server.ts"). Use start_line/end_line to read a slice of a ' +
    'large file. Always read a file before editing it.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository-relative file path' },
      start_line: { type: 'integer', description: 'Optional 1-based first line to return' },
      end_line: { type: 'integer', description: 'Optional 1-based last line to return' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey);
    guard.assertCanRead(input.path);

    if (input.start_line || input.end_line) {
      const slice = await ctx.workspace.readLines(
        input.path,
        input.start_line ?? 1,
        input.end_line ?? (input.start_line ?? 1) + 200,
      );
      return { output: `--- ${input.path} (lines ${input.start_line ?? 1}-${input.end_line ?? '...'}) ---\n${slice}` };
    }

    const content = await ctx.workspace.readFile(input.path);
    return {
      output: `--- ${input.path} ---\n${truncate(content, 60_000)}`,
      data: { path: input.path, bytes: content.length },
    };
  },
});

interface ListInput {
  path?: string;
}

/** Directory listing — the cheapest way for an agent to orient itself. */
export const listDirectoryTool = defineTool<ListInput>({
  name: 'list_directory',
  description:
    'List the entries of a directory in the repository. Build/vendor directories ' +
    '(node_modules, dist, .git, venv, ...) are hidden. Defaults to the repository root.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository-relative directory path (default ".")' },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const target = input.path ?? '.';
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey);
    guard.assertCanRead(target === '.' ? 'README.md' : target);

    const entries = await ctx.workspace.listDirectory(target);
    return {
      output: entries.length
        ? `${target}/\n${entries.map((e) => `  ${e}`).join('\n')}`
        : `${target}/ is empty`,
      data: { count: entries.length },
    };
  },
});
