import { defineTool, type ToolContext, type ToolResult } from './types';
import { PermissionGuard } from './permission-guard';
import { isSecretPath, redactSecrets } from '../security/secret-paths';
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
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey, ctx.packages);
    const target = guard.assertCanRead(input.path);

    if (input.start_line || input.end_line) {
      const slice = await ctx.workspace.readLines(
        target,
        input.start_line ?? 1,
        input.end_line ?? (input.start_line ?? 1) + 200,
      );
      return {
        output:
          `--- ${target} (lines ${input.start_line ?? 1}-${input.end_line ?? '...'}) ---\n` +
          redactSecrets(slice),
      };
    }

    const content = await ctx.workspace.readFile(target);
    // Second line of defence: the path passed the secret filter, but the file
    // may still contain a hardcoded credential we do not want in the transcript.
    return {
      output: `--- ${target} ---\n${redactSecrets(truncate(content, 60_000))}`,
      data: { path: target, bytes: content.length },
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
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey, ctx.packages);
    const raw = (input.path ?? '.').trim();
    const isRoot = raw === '' || raw === '.' || raw === './' || raw === '/';
    // The root has no canonical relative form, and listing it is how an agent
    // orients itself — so it is always allowed, and the *entries* are filtered.
    const target = isRoot ? '.' : guard.canonicalPath(raw);
    if (!isRoot) guard.assertCanRead(target);

    const entries = await ctx.workspace.listDirectory(target);

    // A directory listing leaks the existence and naming of files an agent may
    // not read, so entries are filtered the same way search results are.
    const visible = entries.filter((entry) => {
      const name = entry.replace(/\/$/, '');
      const childPath = isRoot ? name : `${target}/${name}`;
      // Directories are shown when anything under them could be readable; the
      // read itself is authorized separately when the agent descends.
      return entry.endsWith('/')
        ? !isSecretPath(childPath) && !isSecretPath(`${childPath}/x`)
        : guard.canRead(childPath);
    });

    const hidden = entries.length - visible.length;
    const label = isRoot ? '.' : target;
    return {
      output: visible.length
        ? `${label}/\n${visible.map((e) => `  ${e}`).join('\n')}` +
          (hidden ? `\n  (${hidden} entr${hidden === 1 ? 'y' : 'ies'} hidden by this agent's read scope)` : '')
        : `${label}/ has no entries readable by this agent`,
      data: { count: visible.length, hidden },
    };
  },
});
