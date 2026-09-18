import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../config/env';
import { resolveInside, resolveInsideReal, toPosix } from '../../utils/path-safety';
import { isSecretPath } from '../../security/secret-paths';
import { ToolExecutionError } from '../../utils/errors';

/**
 * Sandboxed filesystem access.
 *
 * A Workspace instance is bound to exactly one project's checkout. Every method
 * takes a *repo-relative* path and refuses anything that escapes the root. The
 * agent layer never receives an absolute path and never touches `fs` directly.
 */

const DEFAULT_IGNORES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor', '.next',
  '.nuxt', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  'coverage', '.gradle', '.idea', '.vscode', 'bin', 'obj', '.terraform',
  '.turbo', '.cache', 'tmp', '.DS_Store',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svgz', '.pdf', '.zip',
  '.gz', '.tar', '.jar', '.war', '.class', '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.mov', '.wasm', '.bin',
]);

export interface WalkEntry {
  relativePath: string;
  absolutePath: string;
  bytes: number;
  extension: string;
}

export interface WalkOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
  extraIgnores?: string[];
}

/** Ceilings for model-supplied search, see `Workspace.search`. */
const MAX_SEARCH_PATTERN_CHARS = 200;
const MAX_SEARCH_LINE_CHARS = 2_000;
const SEARCH_TIME_BUDGET_MS = 10_000;

/**
 * Compile a model-supplied regular expression, rejecting the shapes that cause
 * catastrophic backtracking.
 *
 * This is a screen, not a proof: a sound answer needs a non-backtracking engine.
 * It is paired with the subject-length cap and the scan deadline above, which
 * are what actually bound the damage — this just turns the common accidental
 * cases into a clear error the agent can correct.
 */
function compileSearchRegex(pattern: string, caseSensitive: boolean): RegExp {
  if (pattern.length > MAX_SEARCH_PATTERN_CHARS) {
    throw new ToolExecutionError(
      `Search pattern is ${pattern.length} characters, over the ${MAX_SEARCH_PATTERN_CHARS} limit. ` +
        'Search for a distinctive identifier instead.',
    );
  }
  // Nested quantifiers — (a+)+, (a*)*, (x|y)+* — are the classic blow-up shape.
  if (/\([^)]*[+*]\s*\)\s*[+*{]/.test(pattern) || /\([^)]*\|[^)]*\)\s*[+*]\s*[+*{]/.test(pattern)) {
    throw new ToolExecutionError(
      'Search pattern contains nested quantifiers, which can take exponential time. ' +
        'Rewrite it without a quantified group inside another quantifier, or search literally.',
    );
  }
  try {
    return new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch (err) {
    throw new ToolExecutionError(`Invalid regular expression: ${(err as Error).message}`);
  }
}

export class Workspace {
  public readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Deterministic on-disk location for a project's checkout. */
  static pathForProject(projectId: string): string {
    return path.join(env.WORKSPACE_ROOT_ABS, projectId);
  }

  static async ensureRoot(): Promise<void> {
    await fs.mkdir(env.WORKSPACE_ROOT_ABS, { recursive: true });
  }

  async exists(relativePath = '.'): Promise<boolean> {
    try {
      await fs.access(resolveInside(this.root, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async readFile(relativePath: string, maxBytes = env.MAX_FILE_BYTES): Promise<string> {
    // The last gate before `fs`: even a caller that skipped the permission guard
    // (the indexer has no agent, so no profile) cannot read a credential file.
    if (isSecretPath(toPosix(relativePath))) {
      throw new ToolExecutionError(
        `'${relativePath}' matches the platform secret policy and cannot be read.`,
        false,
      );
    }
    const abs = await resolveInsideReal(this.root, relativePath);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw new ToolExecutionError(`File not found: ${relativePath}`);
    if (stat.isDirectory()) throw new ToolExecutionError(`'${relativePath}' is a directory, not a file`);
    if (stat.size > maxBytes) {
      throw new ToolExecutionError(
        `File '${relativePath}' is ${stat.size} bytes, over the ${maxBytes}-byte tool limit. ` +
          'Read a specific range or use code_search to locate the relevant section.',
      );
    }
    if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      throw new ToolExecutionError(`File '${relativePath}' is binary and cannot be read as text`);
    }
    return fs.readFile(abs, 'utf8');
  }

  async readLines(relativePath: string, start: number, end: number): Promise<string> {
    const content = await this.readFile(relativePath);
    const lines = content.split('\n');
    const from = Math.max(1, start);
    const to = Math.min(lines.length, end);
    return lines
      .slice(from - 1, to)
      .map((line, i) => `${from + i}\t${line}`)
      .join('\n');
  }

  async writeFile(relativePath: string, content: string): Promise<{ bytes: number; created: boolean }> {
    if (isSecretPath(toPosix(relativePath))) {
      throw new ToolExecutionError(
        `'${relativePath}' matches the platform secret policy and cannot be written.`,
        false,
      );
    }
    // `MAX_FILE_BYTES` gated reads but not writes, so a model could generate a
    // file far larger than it could ever read back (audit: "Gate generated file
    // sizes as well as reads").
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > env.MAX_FILE_BYTES) {
      throw new ToolExecutionError(
        `Refusing to write ${bytes} bytes to '${relativePath}': over the ${env.MAX_FILE_BYTES}-byte ` +
          'limit. Split the change across files, or write only the section that must change.',
      );
    }

    const abs = await resolveInsideReal(this.root, relativePath);
    const existed = await fs
      .access(abs)
      .then(() => true)
      .catch(() => false);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return { bytes, created: !existed };
  }

  async deleteFile(relativePath: string): Promise<void> {
    const abs = await resolveInsideReal(this.root, relativePath);
    await fs.rm(abs, { force: true });
  }

  async listDirectory(relativePath = '.'): Promise<string[]> {
    const abs = await resolveInsideReal(this.root, relativePath);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => !DEFAULT_IGNORES.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  }

  async stat(relativePath: string): Promise<{ bytes: number; isDirectory: boolean } | null> {
    try {
      const abs = await resolveInsideReal(this.root, relativePath);
      const s = await fs.stat(abs);
      return { bytes: s.size, isDirectory: s.isDirectory() };
    } catch {
      return null;
    }
  }

  /** Depth-first walk of source files, skipping vendored/build directories. */
  async walk(options: WalkOptions = {}): Promise<WalkEntry[]> {
    const maxFiles = options.maxFiles ?? 20_000;
    const ignores = new Set([...DEFAULT_IGNORES, ...(options.extraIgnores ?? [])]);
    const results: WalkEntry[] = [];

    const visit = async (dir: string): Promise<void> => {
      if (results.length >= maxFiles) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxFiles) return;
        if (ignores.has(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue; // never follow symlinks during indexing
        if (entry.isDirectory()) {
          await visit(abs);
        } else if (entry.isFile()) {
          const relativePath = toPosix(path.relative(this.root, abs));
          // Secrets are excluded at the walk, so nothing downstream — indexer,
          // search, ranker, prompt builder — ever sees them (audit finding S5).
          if (isSecretPath(relativePath)) continue;
          const stat = await fs.stat(abs).catch(() => null);
          if (!stat) continue;
          results.push({
            relativePath,
            absolutePath: abs,
            bytes: stat.size,
            extension: path.extname(entry.name).toLowerCase(),
          });
        }
      }
    };

    await visit(this.root);
    return results;
  }

  /**
   * Literal / regex search across text files. Backs the CodeSearch tool.
   *
   * This runs in the API process on a model-supplied pattern, so it is bounded
   * three ways (audit finding S9): the pattern is length-limited and screened
   * for catastrophic backtracking shapes, each candidate line is truncated
   * before matching so a single pathological line cannot dominate, and the whole
   * scan carries a wall-clock deadline.
   */
  async search(
    pattern: string,
    options: {
      regex?: boolean;
      maxResults?: number;
      pathFilter?: string;
      caseSensitive?: boolean;
      timeBudgetMs?: number;
    } = {},
  ): Promise<{ path: string; line: number; text: string }[]> {
    const maxResults = options.maxResults ?? 60;
    const deadline = Date.now() + (options.timeBudgetMs ?? SEARCH_TIME_BUDGET_MS);
    const matcher = options.regex
      ? compileSearchRegex(pattern, options.caseSensitive ?? false)
      : null;
    const needle = options.caseSensitive ? pattern : pattern.toLowerCase();

    const files = await this.walk({ maxFiles: 8000 });
    const hits: { path: string; line: number; text: string }[] = [];

    for (const file of files) {
      if (hits.length >= maxResults) break;
      if (Date.now() > deadline) break;
      if (options.pathFilter && !file.relativePath.includes(options.pathFilter)) continue;
      if (BINARY_EXTENSIONS.has(file.extension)) continue;
      if (file.bytes > env.MAX_FILE_BYTES) continue;

      let content: string;
      try {
        content = await fs.readFile(file.absolutePath, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && hits.length < maxResults; i += 1) {
        // Bound the input to the matcher, not just the output: backtracking cost
        // grows with the subject length, so this is the load-bearing limit.
        const line = (lines[i] ?? '').slice(0, MAX_SEARCH_LINE_CHARS);
        const found = matcher
          ? matcher.test(line)
          : (options.caseSensitive ? line : line.toLowerCase()).includes(needle);
        if (found) {
          hits.push({ path: file.relativePath, line: i + 1, text: line.trim().slice(0, 300) });
        }
        // Checking the deadline every 512 lines keeps the check itself cheap.
        if ((i & 511) === 0 && Date.now() > deadline) break;
      }
    }
    return hits;
  }

  static hashContent(content: string): string {
    return crypto.createHash('sha1').update(content).digest('hex').slice(0, 16);
  }

  static isBinaryExtension(extension: string): boolean {
    return BINARY_EXTENSIONS.has(extension.toLowerCase());
  }
}
