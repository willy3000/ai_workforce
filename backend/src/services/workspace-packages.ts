import fs from 'node:fs/promises';
import path from 'node:path';
import { toPosix } from '../utils/path-safety';

/**
 * Detect the packages inside a checkout.
 *
 * ## Why this exists
 * Role write scopes are globs like `src/**` and `app/**`, written as if every
 * repository were a single package at its root. Many are not: a repository with
 * `project-mibm-back/` and `inventory-project/` side by side puts every real
 * source file under a package directory, so `src/**` matched nothing and both
 * engineers were blocked on their first write. Widening the globs to
 * `**\/src/**` would have "fixed" that by letting the backend engineer write
 * into the frontend app, which is the separation the scopes exist to enforce.
 *
 * Instead, the permission guard evaluates a role's globs *relative to the
 * package a path belongs to*, and only for packages whose kind that role owns.
 * This module supplies the packages and their kinds.
 *
 * Detection is deliberately shallow (two levels) and manifest-driven. It runs
 * at the start of every agent run rather than being stored at onboarding, so
 * existing projects work without a reanalysis and a package the agents create
 * mid-run is picked up by the next step.
 */

export type PackageKind = 'backend' | 'frontend' | 'fullstack' | 'unknown';

export interface WorkspacePackage {
  /** Repository-relative directory, POSIX separators, never empty (root excluded). */
  root: string;
  kind: PackageKind;
  /** The manifest that identified it, for the agent's orientation note. */
  manifest: string;
}

const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'Cargo.toml',
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'vendor', 'target',
  'coverage', '.venv', 'venv', '__pycache__', '.turbo', '.cache', 'tmp',
]);

/** Dependencies whose presence means "this package renders a UI". */
const FRONTEND_MARKERS = [
  'next', 'react', 'react-dom', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', 'vite',
  '@angular/core', 'solid-js', 'astro', 'gatsby', 'preact', '@remix-run/react',
];

/** Dependencies whose presence means "this package serves requests or owns data". */
const BACKEND_MARKERS = [
  'express', 'fastify', 'koa', '@nestjs/core', 'hapi', '@hapi/hapi', 'hono',
  'mongoose', 'monk', 'mongodb', 'prisma', '@prisma/client', 'sequelize',
  'typeorm', 'pg', 'mysql2', 'knex', 'drizzle-orm', 'bullmq', 'restify',
];

/**
 * Classify a `package.json` by its dependencies.
 *
 * Next.js is counted as frontend even though it has server routes: the audit
 * noted that the frontend role already owns `app/**`, including API routes, and
 * treating every Next app as fullstack would let the backend engineer edit UI.
 * A package that also pulls in a server framework or a database driver is
 * genuinely fullstack and both engineers may work in it.
 */
export function classifyPackageJson(manifest: unknown): PackageKind {
  if (!manifest || typeof manifest !== 'object') return 'unknown';
  const pkg = manifest as Record<string, unknown>;
  const deps = {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
  };
  const names = Object.keys(deps);
  const frontend = names.some((n) => FRONTEND_MARKERS.includes(n));
  const backend = names.some((n) => BACKEND_MARKERS.includes(n));
  if (frontend && backend) return 'fullstack';
  if (frontend) return 'frontend';
  if (backend) return 'backend';
  return 'unknown';
}

export async function detectPackages(workspaceRoot: string, maxDepth = 2): Promise<WorkspacePackage[]> {
  const found: WorkspacePackage[] = [];

  const visit = async (relativeDir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const absolute = path.join(workspaceRoot, relativeDir);
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }

    // The root itself is not a "package" for scoping purposes: root-anchored
    // globs already describe it, which is how single-package repos work today.
    if (relativeDir) {
      const manifest = MANIFESTS.find((m) => entries.some((e) => e.isFile() && e.name === m));
      if (manifest) {
        found.push({
          root: toPosix(relativeDir),
          kind: await classify(absolute, manifest),
          manifest,
        });
        // Nested packages inside a package (e.g. a workspace's own sub-apps)
        // are still worth finding, so keep descending.
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await visit(relativeDir ? `${relativeDir}/${entry.name}` : entry.name, depth + 1);
    }
  };

  await visit('', 0);
  return found;
}

async function classify(directory: string, manifest: string): Promise<PackageKind> {
  if (manifest === 'package.json') {
    try {
      const raw = await fs.readFile(path.join(directory, 'package.json'), 'utf8');
      return classifyPackageJson(JSON.parse(raw));
    } catch {
      return 'unknown';
    }
  }
  // Python, Go, JVM, PHP, Ruby and Rust manifests in a subdirectory are, in
  // practice, services. A package.json alongside them is classified above first.
  return 'backend';
}

/** The deepest package containing a canonical repository-relative path, if any. */
export function packageFor(
  relativePath: string,
  packages: readonly WorkspacePackage[],
): WorkspacePackage | undefined {
  let best: WorkspacePackage | undefined;
  for (const pkg of packages) {
    if (relativePath === pkg.root || relativePath.startsWith(`${pkg.root}/`)) {
      if (!best || pkg.root.length > best.root.length) best = pkg;
    }
  }
  return best;
}

/** A short orientation block for an agent's prompt. */
export function describePackages(packages: readonly WorkspacePackage[], agentKinds?: PackageKind[]): string {
  if (!packages.length) return '';
  const lines = packages.map((pkg) => {
    const yours = !agentKinds || agentKinds.includes(pkg.kind);
    return `- \`${pkg.root}/\` — ${pkg.kind} package (${pkg.manifest})${yours ? '' : ' — owned by another role; do not edit'}`;
  });
  return [
    '## Repository layout',
    'This repository contains several packages. Paths you read and write must include the package directory',
    '(for example `' + `${packages[0].root}/src/...` + '`, not `src/...`). Your write scope applies inside each package you own.',
    'When you run a command for a package, pass its directory as `cwd` so installs and tests happen in the right place.',
    ...lines,
  ].join('\n');
}
