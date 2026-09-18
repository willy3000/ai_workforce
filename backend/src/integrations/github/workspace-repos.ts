import fs from 'node:fs/promises';
import path from 'node:path';
import { GitManager } from './git-manager';
import { toPosix } from '../../utils/path-safety';

/**
 * The git repositories that make up a checkout.
 *
 * A GitHub clone is one repository at the workspace root. A local import can be
 * several: this platform's own test project is a folder holding a backend and a
 * frontend, each its own repository, with no repository at the top. Treating
 * the workspace as one repository is what sent git walking up into the
 * platform's source tree, so every git operation now targets one of these.
 */
export interface WorkspaceRepo {
  /** Repository-relative directory; '' for a repository at the workspace root. */
  root: string;
  absolutePath: string;
  git: GitManager;
}

const SKIP = new Set(['node_modules', 'dist', 'build', 'vendor', '.next', 'target', 'coverage']);

export async function discoverRepos(workspaceRoot: string, maxDepth = 2): Promise<WorkspaceRepo[]> {
  const root = path.resolve(workspaceRoot);
  if (await GitManager.isRepositoryRoot(root)) {
    // A root repository owns everything beneath it; nested checkouts inside it
    // would be submodules, which the platform does not manage.
    return [{ root: '', absolutePath: root, git: new GitManager(root) }];
  }

  const found: WorkspaceRepo[] = [];
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const absolute = path.join(root, relative);
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    if (relative && entries.some((e) => e.name === '.git') && (await GitManager.isRepositoryRoot(absolute))) {
      found.push({ root: toPosix(relative), absolutePath: absolute, git: new GitManager(absolute) });
      return; // do not descend into a repository looking for more
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      await visit(relative ? path.join(relative, entry.name) : entry.name, depth + 1);
    }
  };
  await visit('', 0);
  return found;
}

/** The repository containing a workspace-relative path, if any. */
export function repoFor(relativePath: string, repos: readonly WorkspaceRepo[]): WorkspaceRepo | undefined {
  let best: WorkspaceRepo | undefined;
  for (const repo of repos) {
    const inside = repo.root === '' || relativePath === repo.root || relativePath.startsWith(`${repo.root}/`);
    if (inside && (!best || repo.root.length > best.root.length)) best = repo;
  }
  return best;
}

/** Workspace-relative path for a path reported by git inside `repo`. */
export function toWorkspacePath(repo: WorkspaceRepo, repoRelative: string): string {
  return repo.root ? `${repo.root}/${repoRelative}` : repoRelative;
}
