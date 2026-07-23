import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../../integrations/filesystem/workspace';
import type { IFileIndexEntry } from '../../database/models/repository.model';
import { env } from '../../config/env';

/**
 * Builds the project file index.
 *
 * The index is what makes retrieval possible without embeddings: for each file
 * we store its path, size, a short summary (leading comment / first meaningful
 * lines) and its declared symbols. That is enough for the ranker to answer
 * "which 15 files matter for this task?" — and it costs one repository walk,
 * not an embedding pass over the whole codebase.
 *
 * Symbol extraction is deliberately regex-based rather than AST-based: it must
 * work for *any* language the platform encounters, including ones we have no
 * parser for. Precision is imperfect; recall is what matters for ranking.
 */

const MANIFEST_FILES = [
  'package.json', 'tsconfig.json', 'requirements.txt', 'pyproject.toml', 'Pipfile',
  'setup.py', 'go.mod', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'Gemfile', 'Cargo.toml', 'nest-cli.json', 'next.config.js', 'vite.config.ts',
  'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile', '.eslintrc.json',
  'prisma/schema.prisma', 'artisan',
];

const IMPORTANT_PATTERNS = [
  /^(src\/)?(index|main|app|server)\.(ts|js|py|go|java|cs|php)$/,
  /^(src\/)?(routes?|router)(\/index)?\.(ts|js)$/,
  /^(src\/)?config\//,
  /^(src\/)?(models?|schemas?|entities)\//,
  /^(src\/)?(controllers?|handlers?)\//,
  /^prisma\/schema\.prisma$/,
  /^(README|CONTRIBUTING|ARCHITECTURE)\.md$/i,
  /^manage\.py$/,
  /^go\.mod$/,
];

const SYMBOL_PATTERNS: RegExp[] = [
  // JS/TS
  /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  // Python
  /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/g,
  /(?:^|\n)\s*class\s+([A-Za-z_]\w*)/g,
  // Go
  /(?:^|\n)func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g,
  /(?:^|\n)type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/g,
  // Java / C#
  /(?:public|private|protected|internal)\s+(?:static\s+)?(?:class|interface|record|enum)\s+([A-Za-z_]\w*)/g,
  // PHP
  /(?:^|\n)\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/g,
  /(?:^|\n)\s*(?:public|private|protected)?\s*function\s+([A-Za-z_]\w*)/g,
];

export interface IndexResult {
  entries: IFileIndexEntry[];
  extensionCounts: Record<string, number>;
  manifests: Record<string, string>;
  totalBytes: number;
}

export class FileIndexer {
  constructor(private readonly workspace: Workspace) {}

  async build(): Promise<IndexResult> {
    const files = await this.workspace.walk({ maxFiles: 20_000 });
    const entries: IFileIndexEntry[] = [];
    const extensionCounts: Record<string, number> = {};
    const manifests: Record<string, string> = {};
    let totalBytes = 0;

    for (const file of files) {
      totalBytes += file.bytes;
      extensionCounts[file.extension] = (extensionCounts[file.extension] ?? 0) + 1;

      const isManifest = MANIFEST_FILES.some(
        (m) => file.relativePath === m || file.relativePath.endsWith(`/${m}`),
      );
      const isCsproj = file.relativePath.endsWith('.csproj');

      // Manifests are read in full (detection needs their contents); other
      // files are read only up to the head we need for summary + symbols.
      if ((isManifest || isCsproj) && file.bytes < env.MAX_FILE_BYTES) {
        const content = await fs.readFile(file.absolutePath, 'utf8').catch(() => '');
        if (content) manifests[file.relativePath] = content;
      }

      if (Workspace.isBinaryExtension(file.extension) || file.bytes > env.MAX_FILE_BYTES) {
        continue; // still counted above, but not summarised
      }

      const content = await fs.readFile(file.absolutePath, 'utf8').catch(() => '');
      if (!content) continue;

      entries.push({
        path: file.relativePath,
        extension: file.extension,
        language: languageForExtension(file.extension),
        bytes: file.bytes,
        lines: content.split('\n').length,
        summary: summarize(content),
        symbols: extractSymbols(content),
        important: IMPORTANT_PATTERNS.some((p) => p.test(file.relativePath)),
        hash: Workspace.hashContent(content),
      });
    }

    return { entries, extensionCounts, manifests, totalBytes };
  }
}

/** First meaningful lines: doc comment if present, otherwise the first code lines. */
function summarize(content: string, maxChars = 300): string {
  const lines = content.split('\n');
  const docLines: string[] = [];

  for (const raw of lines.slice(0, 40)) {
    const line = raw.trim();
    if (!line) continue;
    const isComment =
      line.startsWith('//') || line.startsWith('*') || line.startsWith('/*') ||
      line.startsWith('#') || line.startsWith('"""') || line.startsWith("'''");
    if (isComment) {
      docLines.push(line.replace(/^[/*#'"\s]+/, '').trim());
      if (docLines.join(' ').length > maxChars) break;
    } else if (docLines.length) {
      break; // comment block ended
    }
  }

  if (docLines.length) return docLines.join(' ').slice(0, maxChars);

  return lines
    .filter((l) => l.trim() && !l.trim().startsWith('import') && !l.trim().startsWith('from '))
    .slice(0, 4)
    .join(' ')
    .slice(0, maxChars);
}

function extractSymbols(content: string, limit = 30): string[] {
  const symbols = new Set<string>();
  const head = content.slice(0, 100_000); // symbols worth ranking on live near the top

  for (const pattern of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(head);
    while (match !== null && symbols.size < limit) {
      if (match[1] && match[1].length > 1) symbols.add(match[1]);
      match = pattern.exec(head);
    }
  }
  return [...symbols].slice(0, limit);
}

function languageForExtension(extension: string): string {
  const map: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
    '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.py': 'Python', '.go': 'Go',
    '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#', '.php': 'PHP', '.rb': 'Ruby',
    '.rs': 'Rust', '.vue': 'Vue', '.svelte': 'Svelte', '.css': 'CSS', '.scss': 'SCSS',
    '.html': 'HTML', '.json': 'JSON', '.yml': 'YAML', '.yaml': 'YAML', '.md': 'Markdown',
    '.sql': 'SQL', '.sh': 'Shell', '.tf': 'Terraform', '.prisma': 'Prisma',
  };
  return map[extension] ?? (extension ? extension.slice(1) : 'unknown');
}

export function importantFilesFor(entries: IFileIndexEntry[], limit = 12): { path: string; reason: string }[] {
  return entries
    .filter((e) => e.important)
    .slice(0, limit)
    .map((e) => ({
      path: e.path,
      reason:
        `${e.language} file, ${e.lines} lines.` +
        (e.symbols.length ? ` Declares: ${e.symbols.slice(0, 8).join(', ')}.` : '') +
        (e.summary ? ` ${e.summary}` : ''),
    }));
}

export function directoryOverview(entries: IFileIndexEntry[], limit = 25): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const top = entry.path.includes('/') ? entry.path.split('/').slice(0, 2).join('/') : path.dirname(entry.path);
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([dir, count]) => `${dir}: ${count} files`)
    .join('\n');
}
