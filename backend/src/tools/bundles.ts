/**
 * Named tool bundles.
 *
 * Deliberately a leaf module with **zero imports**. Agent definitions need the
 * bundle names, and some tools (create_task, send_message) need the agent
 * registry to validate their arguments — which would otherwise form an import
 * cycle: tools/registry → collaboration.tool → agents/registry → definitions →
 * tools/registry, evaluated before `TOOL_BUNDLES` exists.
 *
 * Keeping the bundles here means definitions depend only on this file, and the
 * cycle is broken at its narrowest point rather than papered over with lazy
 * requires. (Cross-checking an agent's tool names against the tool registry
 * happens once at boot in `bootstrap/validate-registries.ts`.)
 */
export const TOOL_BUNDLES = {
  /** Optional unsigned advisory tools. No executable payment capability. */
  agentproof: ['kushbitx_preview_token', 'kushbitx_evaluate_spend', 'kushbitx_get_payment_challenge'],
  /** Read-only repository inspection. Every agent gets these. */
  inspect: ['read_file', 'list_directory', 'code_search', 'find_files'],
  /** Long-term memory access. Every agent gets these. */
  memory: ['recall_project_memory', 'remember'],
  /** Collaboration primitives. Every agent gets these. */
  collaborate: ['send_message', 'report_completion'],
  /** File mutation. Engineers only. */
  edit: ['write_file', 'edit_file', 'delete_file'],
  /** Command execution. Engineers and QA. */
  terminal: ['run_command'],
  /** Version control. PR creation is a separate, approval-gated bundle. */
  git: ['git_status', 'create_branch', 'commit_changes'],
  publish: ['open_pull_request'],
} as const satisfies Record<string, readonly string[]>;

export type ToolBundleName = keyof typeof TOOL_BUNDLES;

/** Compose bundles into a de-duplicated tool-name list for an agent definition. */
export function bundle(...names: ToolBundleName[]): string[] {
  return [...new Set(names.flatMap((name) => [...TOOL_BUNDLES[name]]))];
}
