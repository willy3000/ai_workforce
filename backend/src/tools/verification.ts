import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInsideReal } from '../utils/path-safety';

export function looksLikeVerification(command: string, args: string[]): boolean {
  if (['pytest', 'tsc', 'vitest', 'jest', 'mocha', 'rspec', 'phpunit', 'ctest', 'eslint'].includes(command)) return true;
  if (command === 'node') return args.includes('--test');
  if (!['npm', 'pnpm', 'yarn', 'npx', 'go', 'dotnet', 'mvn', 'gradle', 'python', 'python3'].includes(command)) return false;
  if (['install', 'ci', 'add', 'remove', 'uninstall'].includes(args[0] ?? '')) return false;
  return args.some((arg) => /^(test|tests|check|lint|typecheck|type-check|build|verify)(:.*)?$/.test(arg)
    || ['tsc', 'vitest', 'jest', 'pytest', 'eslint'].includes(arg));
}

export interface VerificationPreparation {
  unavailable?: string;
  install?: { command: string; args: string[]; cwd: string };
}

/** Inspect capabilities before running invented scripts or downloading ad-hoc test tools. */
export async function prepareVerification(
  command: string, args: string[], cwd: string, root: string,
): Promise<VerificationPreparation> {
  if (!['npm', 'pnpm', 'yarn', 'npx'].includes(command) || !looksLikeVerification(command, args)) return {};
  const manifestPath = await resolveInsideReal(root, path.relative(root, path.join(cwd, 'package.json')));
  const raw = await fs.readFile(manifestPath, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!raw) return {};
  const manifest = JSON.parse(raw) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    packageManager?: string;
  };
  const scripts = manifest.scripts ?? {};
  const script = ['run', 'run-script'].includes(args[0]) ? args[1]
    : command !== 'npx' && ['test', 'build', 'lint', 'check', 'typecheck', 'verify'].includes(args[0]) ? args[0] : undefined;
  if (script && !scripts[script]) {
    return { unavailable: `No '${script}' script is configured in this package. Available scripts: ${Object.keys(scripts).join(', ') || '(none)'}. Choose an existing check; this is not a failed test. Report the verification limitation.` };
  }
  if (command === 'npx' && ['jest', 'vitest', 'playwright'].includes(args[0])
    && !manifest.dependencies?.[args[0]] && !manifest.devDependencies?.[args[0]]) {
    return { unavailable: `${args[0]} is not declared by this package. Use its existing verification tooling; do not create tests that cannot run or download an unrelated framework.` };
  }
  // Workspaces may hoist dependencies. Install at the nearest lockfile root.
  let installRoot = cwd;
  for (let current = cwd; ; current = path.dirname(current)) {
    if (await exists(path.join(current, 'node_modules')) || await exists(path.join(current, '.pnp.cjs'))) return {};
    if (await exists(path.join(current, 'package-lock.json')) || await exists(path.join(current, 'pnpm-lock.yaml'))
      || await exists(path.join(current, 'yarn.lock'))) {
      installRoot = current;
      break;
    }
    if (path.resolve(current) === path.resolve(root) || path.dirname(current) === current) break;
  }
  const manager = manifest.packageManager?.split('@')[0];
  if (manager === 'pnpm' || await exists(path.join(installRoot, 'pnpm-lock.yaml'))) {
    return { install: { command: 'pnpm', args: ['install'], cwd: installRoot } };
  }
  if (manager === 'yarn' || await exists(path.join(installRoot, 'yarn.lock'))) {
    return { install: { command: 'yarn', args: ['install'], cwd: installRoot } };
  }
  const locked = await exists(path.join(installRoot, 'package-lock.json'));
  return { install: { command: 'npm', args: locked ? ['ci', '--include=dev'] : ['install', '--include=dev', '--package-lock=false'], cwd: installRoot } };
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

/** Keep the full attempt history in storage; judge each command by its latest result. */
export function latestChecks<T extends { command: string }>(checks: readonly T[]): T[] {
  return [...new Map(checks.map((check) => [check.command, check])).values()];
}
