import { PermissionDeniedError } from '../utils/errors';
import { matchesAnyGlob, stripLeadingSlash, toPosix } from '../utils/path-safety';
import type { AgentPermissions } from '../agents/types';

/**
 * Central authorization for agent actions.
 *
 * Rules, in evaluation order:
 *   1. Explicit deny wins over everything (`denyPaths`).
 *   2. The action must be positively allowed by a glob in the relevant list.
 *   3. Absence of a rule means denied, not allowed.
 *
 * This is the single choke point: `FileEditor` cannot write, `TerminalExecutor`
 * cannot spawn, and `GitManager` cannot push without passing through here.
 * Concretely, this is what stops the Frontend Engineer from editing
 * `Dockerfile`, `.github/workflows/**`, or `infra/**` even if the model decides
 * that would be helpful.
 */
export class PermissionGuard {
  constructor(
    private readonly permissions: AgentPermissions,
    private readonly agentKey: string,
  ) {}

  assertCanRead(filePath: string): void {
    const normalized = this.normalize(filePath);
    if (matchesAnyGlob(this.permissions.denyPaths, normalized)) {
      throw new PermissionDeniedError(
        `Agent '${this.agentKey}' is explicitly denied read access to '${normalized}'`,
      );
    }
    if (!matchesAnyGlob(this.permissions.readPaths, normalized)) {
      throw new PermissionDeniedError(
        `Agent '${this.agentKey}' may only read: ${this.permissions.readPaths.join(', ')}. ` +
          `'${normalized}' is outside that scope.`,
      );
    }
  }

  assertCanWrite(filePath: string): void {
    const normalized = this.normalize(filePath);
    if (matchesAnyGlob(this.permissions.denyPaths, normalized)) {
      throw new PermissionDeniedError(
        `Agent '${this.agentKey}' is explicitly denied write access to '${normalized}'. ` +
          'Escalate to the engineering-manager if this change is genuinely required.',
      );
    }
    if (!this.permissions.writePaths.length) {
      throw new PermissionDeniedError(
        `Agent '${this.agentKey}' has no write permissions. It is a read-only/advisory role.`,
      );
    }
    if (!matchesAnyGlob(this.permissions.writePaths, normalized)) {
      throw new PermissionDeniedError(
        `Agent '${this.agentKey}' may only write to: ${this.permissions.writePaths.join(', ')}. ` +
          `'${normalized}' is outside that scope — hand this off to the agent that owns it.`,
      );
    }
  }

  assertCanRunCommand(command: string): void {
    if (!this.permissions.allowTerminal) {
      throw new PermissionDeniedError(`Agent '${this.agentKey}' may not execute commands`);
    }
    if (!this.permissions.allowedCommands.includes(command)) {
      throw new PermissionDeniedError(
        `Command '${command}' is not allowed for agent '${this.agentKey}'. ` +
          `Allowed: ${this.permissions.allowedCommands.join(', ') || '(none)'}`,
      );
    }
  }

  assertCanWriteGit(): void {
    if (!this.permissions.allowGitWrite) {
      throw new PermissionDeniedError(
        `Agent '${this.agentKey}' may not create branches, commit, or push`,
      );
    }
  }

  /** True when a mutating action must be approved by a human before it runs. */
  requiresApproval(): boolean {
    return this.permissions.requiresHumanApproval;
  }

  private normalize(filePath: string): string {
    return toPosix(stripLeadingSlash(filePath.trim()));
  }
}
