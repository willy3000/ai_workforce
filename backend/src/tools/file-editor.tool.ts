import { defineTool, type ToolResult } from './types';
import { PermissionGuard } from './permission-guard';
import { ToolExecutionError } from '../utils/errors';
import { truncate } from '../utils/text';

interface WriteFileInput {
  path: string;
  content: string;
  reason: string;
}

/**
 * Create or overwrite a file.
 *
 * Every write is (a) permission-checked against the agent's `writePaths`,
 * (b) recorded as a task artifact with the agent's stated reason, so a human
 * reviewing the run sees *what* changed and *why* without reading the diff.
 */
export const writeFileTool = defineTool<WriteFileInput>({
  name: 'write_file',
  description:
    'Create a new file or completely replace an existing one. You must read an existing file ' +
    'before overwriting it. For a targeted change to a large file, prefer edit_file. ' +
    'Always supply a short reason describing the intent of the change.',
  mutating: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository-relative file path' },
      content: { type: 'string', description: 'Full file content to write' },
      reason: { type: 'string', description: 'One sentence: why this file is being written' },
    },
    required: ['path', 'content', 'reason'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey);
    guard.assertCanWrite(input.path);

    const { bytes, created } = await ctx.workspace.writeFile(input.path, input.content);
    await ctx.recordArtifact({
      type: 'file',
      path: input.path,
      content: `${created ? 'created' : 'updated'} (${bytes} bytes): ${input.reason}`,
    });
    ctx.logger.info({ path: input.path, bytes, created }, 'Agent wrote file');

    return {
      output: `${created ? 'Created' : 'Updated'} ${input.path} (${bytes} bytes).`,
      data: { path: input.path, bytes, created },
    };
  },
});

interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
  reason: string;
}

/**
 * Exact string replacement.
 *
 * The uniqueness requirement is deliberate: it turns "the model guessed wrong
 * about the file's contents" into a clean, recoverable tool error rather than a
 * silent edit in the wrong place.
 */
export const editFileTool = defineTool<EditFileInput>({
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must appear EXACTLY ONCE in the file — ' +
    'include enough surrounding context to make it unique. This is the preferred way to ' +
    'modify existing code because it cannot accidentally discard the rest of the file.',
  mutating: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository-relative file path' },
      old_string: { type: 'string', description: 'Exact text to replace (must be unique in the file)' },
      new_string: { type: 'string', description: 'Replacement text' },
      reason: { type: 'string', description: 'One sentence: why this edit is being made' },
    },
    required: ['path', 'old_string', 'new_string', 'reason'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey);
    guard.assertCanWrite(input.path);

    const content = await ctx.workspace.readFile(input.path);
    const occurrences = content.split(input.old_string).length - 1;

    if (occurrences === 0) {
      throw new ToolExecutionError(
        `old_string not found in ${input.path}. Read the file again — its current contents ` +
          'may differ from what you assumed (whitespace and indentation must match exactly).',
      );
    }
    if (occurrences > 1) {
      throw new ToolExecutionError(
        `old_string appears ${occurrences} times in ${input.path}. Add surrounding context to ` +
          'make it unique, or perform the edits one at a time.',
      );
    }

    const updated = content.replace(input.old_string, input.new_string);
    const { bytes } = await ctx.workspace.writeFile(input.path, updated);
    await ctx.recordArtifact({
      type: 'file',
      path: input.path,
      content: `edited: ${input.reason}\n- ${truncate(input.old_string, 400)}\n+ ${truncate(input.new_string, 400)}`,
    });
    ctx.logger.info({ path: input.path, bytes }, 'Agent edited file');

    return { output: `Edited ${input.path} (now ${bytes} bytes).`, data: { path: input.path } };
  },
});

interface DeleteFileInput {
  path: string;
  reason: string;
}

export const deleteFileTool = defineTool<DeleteFileInput>({
  name: 'delete_file',
  description:
    'Delete a file from the repository. Use sparingly and only when the task explicitly ' +
    'calls for removing it.',
  mutating: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository-relative file path' },
      reason: { type: 'string', description: 'Why this file must be deleted' },
    },
    required: ['path', 'reason'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey);
    guard.assertCanWrite(input.path);

    const stat = await ctx.workspace.stat(input.path);
    if (!stat) throw new ToolExecutionError(`File not found: ${input.path}`);
    if (stat.isDirectory) throw new ToolExecutionError('Refusing to delete a directory');

    await ctx.workspace.deleteFile(input.path);
    await ctx.recordArtifact({ type: 'file', path: input.path, content: `deleted: ${input.reason}` });
    return { output: `Deleted ${input.path}.`, data: { path: input.path } };
  },
});
