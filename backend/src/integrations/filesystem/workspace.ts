import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../config/env';
import { resolveInside, resolveInsideReal, toPosix } from '../../utils/path-safety';
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
    const abs = await resolveInsideReal(this.root, relativePath);
    const existed = await fs
      .access(abs)
      .then(() => true)
      .catch(() => false);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return { bytes: Buffer.byteLength(content, 'utf8'), created: !existed };
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
          const stat = await fs.stat(abs).catch(() => null);
          if (!stat) continue;
          results.push({
            relativePath: toPosix(path.relative(this.root, abs)),
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

  /** Literal / regex search across text files. Backs the CodeSearch tool. */
  async search(
    pattern: string,
    options: { regex?: boolean; maxResults?: number; pathFilter?: string; caseSensitive?: boolean } = {},
  ): Promise<{ path: string; line: number; text: string }[]> {
    const maxResults = options.maxResults ?? 60;
    const matcher = options.regex
      ? new RegExp(pattern, options.caseSensitive ? '' : 'i')
      : null;
    const needle = options.caseSensitive ? pattern : pattern.toLowerCase();

    const files = await this.walk({ maxFiles: 8000 });
    const hits: { path: string; line: number; text: string }[] = [];

    for (const file of files) {
      if (hits.length >= maxResults) break;
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
        const line = lines[i] ?? '';
        const found = matcher
          ? matcher.test(line)
          : (options.caseSensitive ? line : line.toLowerCase()).includes(needle);
        if (found) {
          hits.push({ path: file.relativePath, line: i + 1, text: line.trim().slice(0, 300) });
        }
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
