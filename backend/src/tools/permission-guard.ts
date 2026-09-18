import { PermissionDeniedError } from '../utils/errors';
import { PathEscapeError, canonicalRelative, matchesAnyGlob } from '../utils/path-safety';
import { isSecretPath } from '../security/secret-paths';
import type { AgentPermissions } from '../agents/types';
import { packageFor, type WorkspacePackage } from '../services/workspace-packages';

/**
 * Central authorization for agent actions.
 *
 * Rules, in evaluation order:
 *   1. The path is canonicalised; an uncanonicalisable path is denied outright.
 *   2. Secret paths are denied to every role, with no allow rule able to
 *      override them.
 *   3. Explicit deny wins over any allow rule (`denyPaths`).
 *   4. The action must be positively allowed by a glob in the relevant list.
 *   5. Absence of a rule means denied, not allowed.
 *
 * This is the single choke point: `FileEditor` cannot write, `TerminalExecutor`
 * cannot spawn, and `GitManager` cannot push without passing through here.
 * Concretely, this is what stops the Frontend Engineer from editing
 * `Dockerfile`, `.github/workflows/**`, or `infra/**` even if the model decides
 * that would be helpful.
 *
 * Step 1 is the important correction. Previously the guard matched globs against
 * the raw model-supplied string while `Workspace` resolved a different one, so a
 * path like `frontend/../backend/app.ts` satisfied a `frontend/**` allow rule
 * and then wrote into `backend/`. Authorization and action now agree on one
 * canonical target, and `canonicalPath()` is what callers must hand to the
 * filesystem.
 *
 * ## Multi-package repositories
 * Given the checkout's packages, a path inside a package is judged by that
 * package: its kind must be one the role owns (`packageKinds`), and the role's
 * globs are matched against the path *relative to the package directory*. So
 * `backend-engineer`'s `src/**` covers `project-mibm-back/src/app.js` but not
 * `inventory-project/src/app/page.js`, which belongs to a frontend package.
 * Deny rules are checked against both the full and the package-relative path,
 * so `api/Dockerfile` stays denied however the path is written.
 */
export class PermissionGuard {
  constructor(
    private readonly permissions: AgentPermissions,
    private readonly agentKey: string,
    private readonly packages: readonly WorkspacePackage[] = [],
  ) {}

  /** The paths globs are evaluated against: the full path, plus package-relative. */
  private scopedPaths(normalized: string): { full: string; relative: string; pkg?: WorkspacePackage } {
    const pkg = packageFor(normalized, this.packages);
    if (!pkg || normalized === pkg.root) return { full: normalized, relative: normalized, pkg };
    return { full: normalized, relative: normalized.slice(pkg.root.length + 1), pkg };
  }

  private matches(globs: string[], scoped: { full: string; relative: string }): boolean {
    return matchesAnyGlob(globs, scoped.full) || matchesAnyGlob(globs, scoped.relative);
  }

  /**
   * Authorize a read and return the canonical path the caller must act on.
   *
   * Callers use the return value rather than their own copy of the input — that
   * is what keeps the authorized target and the touched target identical.
   */
  assertCanRead(filePath: string): string {
    const normalized = this.canonicalPath(filePath);
    if (isSecretPath(normalized)) {
      throw new PermissionDeniedError(
        `'${normalized}' matches the platform secret policy and is unreadable by every agent. ` +
          'If this file is genuinely not a credential, rename it or read the non-secret file ' +
          'that documents its shape (e.g. .env.example).',
      );
    }
    const scoped = this.scopedPaths(normalized);
    if (this.matches(this.permissions.denyPaths, scoped)) {
      throw new PermissionDeniedError(
        `Agent '${this.agentKey}' is explicitly denied read access to '${normalized}'`,
      );
    }
    if (!this.matches(this.permissions.readPaths, scoped)) {
      throw new PermissionDeniedError(
        `Agent '${this.agentKey}' may only read: ${this.permissions.readPaths.join(', ')}. ` +
          `'${normalized}' is outside that scope.`,
      );
    }
    return normalized;
  }

  /** Authorize a write and return the canonical path the caller must act on. */
  assertCanWrite(filePath: string): string {
    const normalized = this.canonicalPath(filePath);
    if (isSecretPath(normalized)) {
      throw new PermissionDeniedError(
        `'${normalized}' matches the platform secret policy and is unwritable by every agent. ` +
          'Credentials are managed outside the repository.',
      );
    }
    const scoped = this.scopedPaths(normalized);
    if (this.matches(this.permissions.denyPaths, scoped)) {
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
    // A package this role does not own is off-limits whatever its globs say:
    // the frontend app's `src/` is not the backend engineer's `src/**`.
    const kinds = this.permissions.packageKinds;
    if (scoped.pkg && kinds && !kinds.includes(scoped.pkg.kind)) {
      throw new PermissionDeniedError(
        `'${normalized}' is inside \`${scoped.pkg.root}/\`, a ${scoped.pkg.kind} package. ` +
          `Agent '${this.agentKey}' works in ${kinds.join('/')} packages — hand this change to the role that owns it.`,
      );
    }
    if (!this.matches(this.permissions.writePaths, scoped)) {
      const where = scoped.pkg ? ` (checked as '${scoped.relative}' inside \`${scoped.pkg.root}/\`)` : '';
      throw new PermissionDeniedError(
        `Agent '${this.agentKey}' may only write to: ${this.permissions.writePaths.join(', ')}. ` +
          `'${normalized}'${where} is outside that scope — hand this off to the agent that owns it.`,
      );
    }
    return normalized;
  }

  /** True when the agent could read this path — used to filter listings, not to authorize. */
  canRead(filePath: string): boolean {
    try {
      this.assertCanRead(filePath);
      return true;
    } catch {
      return false;
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

  /**
   * Collapse to the canonical repository-relative path, converting a traversal
   * attempt into a permission denial rather than a filesystem error — the model
   * gets a message it can act on, and the operator gets a policy event.
   */
  canonicalPath(filePath: string): string {
    try {
      return canonicalRelative(filePath);
    } catch (err) {
      if (err instanceof PathEscapeError) {
        throw new PermissionDeniedError(
          `'${filePath}' is not a valid repository-relative path. Use a plain path such as ` +
            '"src/server.ts" — absolute paths, drive letters and ".." traversal are rejected.',
        );
      }
      throw err;
    }
  }
}
