import type { Tool } from './types';
import type { LlmToolDefinition } from '../services/llm/types';
import { listDirectoryTool, repositoryReaderTool } from './repository-reader.tool';
import { codeSearchTool, findFilesTool } from './code-search.tool';
import { deleteFileTool, editFileTool, writeFileTool } from './file-editor.tool';
import { runCommandTool } from './terminal.tool';
import { commitTool, createBranchTool, gitStatusTool, openPullRequestTool } from './git.tool';
import { recallMemoryTool, recordDecisionTool, rememberTool } from './memory.tool';
import {
  createTaskTool,
  reportCompletionTool,
  sendMessageTool,
} from './collaboration.tool';

/**
 * The tool catalogue.
 *
 * Agents reference tools *by name*. The registry resolves those names to
 * implementations and renders the JSON-schema definitions sent to the model.
 * Two consequences worth calling out:
 *
 *  - An agent can only ever call a tool that its definition lists. Tools are not
 *    ambient capabilities; the model literally never sees the schema of a tool
 *    the agent doesn't have, which is a far stronger guarantee than prompting.
 *  - The tool list per agent is stable across a workflow, which keeps the
 *    prompt-cache prefix intact (tools render before the system prompt).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool<never>>();

  register(tool: Tool<never>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool<never> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  all(): Tool<never>[] {
    return [...this.tools.values()];
  }

  /** Resolve an agent's tool names, failing loudly on a typo in a definition. */
  resolve(names: string[]): Tool<never>[] {
    return names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`Unknown tool '${name}' requested by an agent definition`);
      return tool;
    });
  }

  /** Render the wire-format tool definitions for a set of tool names. */
  toLlmDefinitions(names: string[]): LlmToolDefinition[] {
    return this.resolve(names).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
}

export const toolRegistry = new ToolRegistry();

// --- Built-in catalogue ----------------------------------------------------
for (const tool of [
  repositoryReaderTool,
  listDirectoryTool,
  codeSearchTool,
  findFilesTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  runCommandTool,
  gitStatusTool,
  createBranchTool,
  commitTool,
  openPullRequestTool,
  recallMemoryTool,
  rememberTool,
  recordDecisionTool,
  createTaskTool,
  sendMessageTool,
  reportCompletionTool,
] as unknown as Tool<never>[]) {
  toolRegistry.register(tool);
}

// Bundle names live in the leaf module `./bundles` to keep agent definitions
// free of an import cycle; re-exported here for convenience.
export { TOOL_BUNDLES, bundle, type ToolBundleName } from './bundles';
