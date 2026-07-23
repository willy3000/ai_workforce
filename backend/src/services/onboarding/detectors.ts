/**
 * Stack detection.
 *
 * Design decision: detection is **evidence-based and layered**, not a single
 * heuristic. Three independent signals are combined:
 *
 *   1. File extensions  → languages (weighted by file count, so one stray
 *      `.py` script in a TypeScript repo doesn't make it "a Python project").
 *   2. Manifest dependencies → frameworks and databases (the strongest signal:
 *      `next` in package.json is proof, `pages/` is only a hint).
 *   3. Marker files/directories → architecture, deployment, testing.
 *
 * Everything here is pure and synchronous over already-read file contents, which
 * makes it directly unit-testable and cheap to extend: adding a language or
 * framework is a table entry, not new control flow.
 */

export interface DetectionInput {
  /** Repo-relative paths of every indexed file. */
  paths: string[];
  /** Contents of the manifest files we care about, keyed by path. */
  manifests: Record<string, string>;
  /** Count of files per extension. */
  extensionCounts: Record<string, number>;
}

export interface DetectionResult {
  languages: string[];
  frameworks: string[];
  database: string;
  testingFramework: string;
  deployment: string;
  architecture: string;
  packageManagers: string[];
  conventions: string[];
  entryPoints: string[];
  buildCommand?: string;
  testCommand?: string;
}

// --- Language table --------------------------------------------------------
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.pyi': 'Python',
  '.java': 'Java', '.kt': 'Kotlin', '.scala': 'Scala',
  '.cs': 'C#', '.fs': 'F#',
  '.php': 'PHP',
  '.go': 'Go',
  '.rb': 'Ruby', '.rs': 'Rust', '.swift': 'Swift', '.dart': 'Dart',
  '.vue': 'Vue', '.svelte': 'Svelte',
  '.sql': 'SQL', '.sh': 'Shell',
};

/** Extensions that are supporting material, not the project's primary language. */
const ANCILLARY_LANGUAGES = new Set(['SQL', 'Shell']);

// --- Framework table -------------------------------------------------------
interface FrameworkRule {
  name: string;
  /** Dependency names that prove this framework is in use. */
  dependencies?: string[];
  /** Paths whose presence implies it. */
  paths?: string[];
  /** Regex over a manifest's raw text (for non-JSON manifests). */
  manifestPattern?: { file: string; pattern: RegExp };
}

const FRAMEWORK_RULES: FrameworkRule[] = [
  { name: 'Next.js', dependencies: ['next'] },
  { name: 'React', dependencies: ['react'] },
  { name: 'Vue', dependencies: ['vue'] },
  { name: 'Svelte', dependencies: ['svelte', '@sveltejs/kit'] },
  { name: 'Angular', dependencies: ['@angular/core'] },
  { name: 'Express', dependencies: ['express'] },
  { name: 'NestJS', dependencies: ['@nestjs/core'] },
  { name: 'Fastify', dependencies: ['fastify'] },
  { name: 'Koa', dependencies: ['koa'] },
  { name: 'Django', manifestPattern: { file: 'requirements.txt', pattern: /^django\b/im } },
  { name: 'Django', paths: ['manage.py'] },
  { name: 'FastAPI', manifestPattern: { file: 'requirements.txt', pattern: /^fastapi\b/im } },
  { name: 'FastAPI', manifestPattern: { file: 'pyproject.toml', pattern: /fastapi/i } },
  { name: 'Flask', manifestPattern: { file: 'requirements.txt', pattern: /^flask\b/im } },
  { name: 'Laravel', manifestPattern: { file: 'composer.json', pattern: /laravel\/framework/i } },
  { name: 'Symfony', manifestPattern: { file: 'composer.json', pattern: /symfony\//i } },
  { name: 'Spring Boot', manifestPattern: { file: 'pom.xml', pattern: /spring-boot/i } },
  { name: 'Spring Boot', manifestPattern: { file: 'build.gradle', pattern: /spring-boot/i } },
  { name: '.NET', manifestPattern: { file: '*.csproj', pattern: /Microsoft\.NET\.Sdk/i } },
  { name: 'ASP.NET Core', manifestPattern: { file: '*.csproj', pattern: /Microsoft\.AspNetCore/i } },
  { name: 'Gin', manifestPattern: { file: 'go.mod', pattern: /gin-gonic\/gin/i } },
  { name: 'Echo', manifestPattern: { file: 'go.mod', pattern: /labstack\/echo/i } },
  { name: 'Rails', paths: ['config/routes.rb'] },
];

// --- Database table --------------------------------------------------------
const DATABASE_RULES: { name: string; patterns: RegExp[] }[] = [
  { name: 'MongoDB', patterns: [/\bmongoose\b/i, /\bmongodb\b/i, /\bpymongo\b/i, /\bmotor\b/i, /go\.mongodb\.org/i] },
  { name: 'PostgreSQL', patterns: [/\bpg\b/, /\bpostgres(ql)?\b/i, /psycopg2?/i, /asyncpg/i, /Npgsql/i, /lib\/pq/i] },
  { name: 'MySQL', patterns: [/\bmysql2?\b/i, /pymysql/i, /mariadb/i, /go-sql-driver\/mysql/i] },
  { name: 'Redis', patterns: [/\bioredis\b/i, /"redis"/i, /\bredis\b/i] },
  { name: 'SQLite', patterns: [/sqlite3?/i, /better-sqlite3/i] },
  { name: 'Prisma', patterns: [/@prisma\/client/i] },
];

// --- Testing table ---------------------------------------------------------
const TESTING_RULES: { name: string; patterns: RegExp[]; paths?: string[] }[] = [
  { name: 'Vitest', patterns: [/"vitest"/] },
  { name: 'Jest', patterns: [/"jest"/] },
  { name: 'Playwright', patterns: [/@playwright\/test/] },
  { name: 'Cypress', patterns: [/"cypress"/] },
  { name: 'Mocha', patterns: [/"mocha"/] },
  { name: 'pytest', patterns: [/^pytest\b/im, /pytest/i] },
  { name: 'unittest', patterns: [], paths: ['tests/__init__.py'] },
  { name: 'PHPUnit', patterns: [/phpunit\/phpunit/i] },
  { name: 'JUnit', patterns: [/junit/i] },
  { name: 'xUnit', patterns: [/xunit/i] },
  { name: 'Go testing', patterns: [], paths: [] },
];

export function detectStack(input: DetectionInput): DetectionResult {
  const { paths, manifests, extensionCounts } = input;
  const pathSet = new Set(paths);
  const allManifestText = Object.values(manifests).join('\n');

  const languages = detectLanguages(extensionCounts);
  const dependencies = collectDependencies(manifests);
  const frameworks = detectFrameworks(dependencies, manifests, pathSet);
  const packageManagers = detectPackageManagers(pathSet);

  return {
    languages,
    frameworks,
    database: detectDatabases(allManifestText, paths).join(', ') || 'none detected',
    testingFramework: detectTesting(allManifestText, pathSet, languages).join(', ') || 'none detected',
    deployment: detectDeployment(pathSet).join(', ') || 'none detected',
    architecture: detectArchitecture(pathSet, paths, frameworks),
    packageManagers,
    conventions: detectConventions(pathSet, manifests),
    entryPoints: detectEntryPoints(pathSet, manifests),
    buildCommand: detectScript(manifests, ['build', 'compile']),
    testCommand: detectScript(manifests, ['test', 'tests']) ?? defaultTestCommand(languages, pathSet),
  };
}

function detectLanguages(extensionCounts: Record<string, number>): string[] {
  const totals = new Map<string, number>();
  for (const [ext, count] of Object.entries(extensionCounts)) {
    const language = LANGUAGE_BY_EXTENSION[ext];
    if (language) totals.set(language, (totals.get(language) ?? 0) + count);
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const maxCount = sorted[0]?.[1] ?? 0;

  // Keep a language if it is a meaningful share of the codebase (>5% of the
  // dominant language) — this filters out stray config/scripts.
  return sorted
    .filter(([lang, count]) => !ANCILLARY_LANGUAGES.has(lang) && count >= Math.max(2, maxCount * 0.05))
    .map(([lang]) => lang);
}

function collectDependencies(manifests: Record<string, string>): Set<string> {
  const deps = new Set<string>();
  for (const [file, content] of Object.entries(manifests)) {
    if (!file.endsWith('package.json')) continue;
    try {
      const parsed = JSON.parse(content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      for (const group of [parsed.dependencies, parsed.devDependencies, parsed.peerDependencies]) {
        for (const name of Object.keys(group ?? {})) deps.add(name);
      }
    } catch {
      // Malformed manifest — fall back to text matching elsewhere.
    }
  }
  return deps;
}

function detectFrameworks(
  dependencies: Set<string>,
  manifests: Record<string, string>,
  paths: Set<string>,
): string[] {
  const found = new Set<string>();

  for (const rule of FRAMEWORK_RULES) {
    if (rule.dependencies?.some((d) => dependencies.has(d))) found.add(rule.name);
    if (rule.paths?.some((p) => paths.has(p))) found.add(rule.name);
    if (rule.manifestPattern) {
      const { file, pattern } = rule.manifestPattern;
      const candidates = file.startsWith('*')
        ? Object.entries(manifests).filter(([name]) => name.endsWith(file.slice(1)))
        : Object.entries(manifests).filter(([name]) => name === file || name.endsWith(`/${file}`));
      if (candidates.some(([, content]) => pattern.test(content))) found.add(rule.name);
    }
  }

  // Next.js implies React; reporting both is noise.
  if (found.has('Next.js')) found.delete('React');
  return [...found];
}

function detectDatabases(manifestText: string, paths: string[]): string[] {
  const found = new Set<string>();
  for (const rule of DATABASE_RULES) {
    if (rule.patterns.some((p) => p.test(manifestText))) found.add(rule.name);
  }
  if (paths.some((p) => p.includes('prisma/schema.prisma'))) found.add('Prisma');
  if (paths.some((p) => /migrations?\//i.test(p))) found.add('(uses migrations)');
  return [...found];
}

function detectTesting(manifestText: string, paths: Set<string>, languages: string[]): string[] {
  const found = new Set<string>();
  for (const rule of TESTING_RULES) {
    if (rule.patterns.length && rule.patterns.some((p) => p.test(manifestText))) found.add(rule.name);
    if (rule.paths?.some((p) => paths.has(p))) found.add(rule.name);
  }
  if (languages.includes('Go') && [...paths].some((p) => p.endsWith('_test.go'))) {
    found.add('Go testing');
  }
  return [...found];
}

function detectDeployment(paths: Set<string>): string[] {
  const found: string[] = [];
  const has = (p: string) => paths.has(p);
  const hasPrefix = (prefix: string) => [...paths].some((p) => p.startsWith(prefix));

  if (has('Dockerfile') || hasPrefix('docker/')) found.push('Docker');
  if ([...paths].some((p) => /^docker-compose.*\.ya?ml$/.test(p))) found.push('Docker Compose');
  if (hasPrefix('.github/workflows/')) found.push('GitHub Actions');
  if (has('.gitlab-ci.yml')) found.push('GitLab CI');
  if (has('Jenkinsfile')) found.push('Jenkins');
  if (hasPrefix('k8s/') || hasPrefix('kubernetes/') || hasPrefix('helm/')) found.push('Kubernetes');
  if (hasPrefix('terraform/') || [...paths].some((p) => p.endsWith('.tf'))) found.push('Terraform');
  if (has('vercel.json')) found.push('Vercel');
  if (has('netlify.toml')) found.push('Netlify');
  if (has('fly.toml')) found.push('Fly.io');
  if (has('Procfile')) found.push('Heroku');
  if (has('serverless.yml')) found.push('Serverless');
  return found;
}

/**
 * Architecture inference.
 *
 * Reported as a best-effort label with a hedge when the signal is weak — an
 * incorrect confident label would be injected into every agent prompt.
 */
function detectArchitecture(paths: Set<string>, allPaths: string[], frameworks: string[]): string {
  const hasPrefix = (prefix: string) => allPaths.some((p) => p.startsWith(prefix));
  const signals: string[] = [];

  const workspaceMarkers = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json'];
  const isMonorepo =
    [...workspaceMarkers].some((m) => paths.has(m)) ||
    (hasPrefix('packages/') && allPaths.filter((p) => p.startsWith('packages/')).length > 10) ||
    (hasPrefix('apps/') && hasPrefix('packages/'));
  if (isMonorepo) signals.push('monorepo');

  if (hasPrefix('services/') && allPaths.some((p) => /services\/[^/]+\/(Dockerfile|package\.json|go\.mod)/.test(p))) {
    signals.push('microservices');
  }
  if (hasPrefix('src/domain/') || hasPrefix('domain/') || hasPrefix('src/application/')) {
    signals.push('layered/hexagonal (domain + application layers)');
  }
  if (hasPrefix('controllers/') || hasPrefix('src/controllers/') || hasPrefix('app/controllers/')) {
    signals.push('MVC');
  }
  if (hasPrefix('src/features/') || hasPrefix('src/modules/')) signals.push('feature-modular');
  if (frameworks.includes('Next.js')) signals.push('Next.js app/pages routing');
  if (frameworks.includes('NestJS')) signals.push('NestJS modules');

  if (!signals.length) {
    return hasPrefix('src/') ? 'conventional src/ layout (structure not conclusive)' : 'flat layout (structure not conclusive)';
  }
  return signals.join(' + ');
}

function detectPackageManagers(paths: Set<string>): string[] {
  const managers: string[] = [];
  if (paths.has('pnpm-lock.yaml')) managers.push('pnpm');
  else if (paths.has('yarn.lock')) managers.push('yarn');
  else if (paths.has('package-lock.json')) managers.push('npm');
  else if (paths.has('package.json')) managers.push('npm');

  if (paths.has('poetry.lock')) managers.push('poetry');
  else if (paths.has('Pipfile.lock')) managers.push('pipenv');
  else if (paths.has('requirements.txt')) managers.push('pip');

  if (paths.has('go.sum') || paths.has('go.mod')) managers.push('go modules');
  if (paths.has('composer.lock') || paths.has('composer.json')) managers.push('composer');
  if (paths.has('pom.xml')) managers.push('maven');
  if (paths.has('build.gradle') || paths.has('build.gradle.kts')) managers.push('gradle');
  if (paths.has('Gemfile')) managers.push('bundler');
  if (paths.has('Cargo.toml')) managers.push('cargo');
  return managers;
}

/**
 * Conventions are the highest-value part of the profile: they are what makes
 * generated code look like it belongs. We report only what we can prove from a
 * config file's presence or contents.
 */
function detectConventions(paths: Set<string>, manifests: Record<string, string>): string[] {
  const conventions: string[] = [];
  const has = (p: string) => paths.has(p);
  const anyMatch = (re: RegExp) => [...paths].some((p) => re.test(p));

  if (anyMatch(/^\.eslintrc/) || has('eslint.config.js') || has('eslint.config.mjs')) {
    conventions.push('ESLint is configured — run the linter before reporting completion');
  }
  if (anyMatch(/^\.prettierrc/) || has('prettier.config.js')) {
    conventions.push('Prettier formats this codebase — match its output, do not hand-format');
  }
  if (has('.editorconfig')) conventions.push('.editorconfig defines indentation and line endings');
  if (has('biome.json')) conventions.push('Biome is used for lint + format');
  if (has('ruff.toml') || /\[tool\.ruff\]/.test(manifests['pyproject.toml'] ?? '')) {
    conventions.push('Ruff lints this Python codebase');
  }
  if (/\[tool\.black\]/.test(manifests['pyproject.toml'] ?? '')) {
    conventions.push('Black formats this Python codebase (88-char lines)');
  }
  if (has('.php-cs-fixer.php') || has('pint.json')) conventions.push('PHP code style is enforced by a fixer');
  if (has('.golangci.yml') || has('.golangci.yaml')) conventions.push('golangci-lint is configured');

  const tsconfig = manifests['tsconfig.json'];
  if (tsconfig) {
    if (/"strict"\s*:\s*true/.test(tsconfig)) {
      conventions.push('TypeScript strict mode is ON — no implicit any, handle null explicitly');
    }
    if (/"paths"\s*:/.test(tsconfig)) {
      conventions.push('tsconfig defines path aliases — use them instead of deep relative imports');
    }
  }
  if (has('.husky/pre-commit') || anyMatch(/^\.husky\//)) {
    conventions.push('Husky git hooks run checks on commit');
  }
  if (has('CONTRIBUTING.md')) conventions.push('CONTRIBUTING.md exists — read it before large changes');
  if (has('.nvmrc')) conventions.push('.nvmrc pins the Node version');

  return conventions;
}

function detectEntryPoints(paths: Set<string>, manifests: Record<string, string>): string[] {
  const candidates = [
    'src/index.ts', 'src/main.ts', 'src/server.ts', 'src/app.ts', 'index.js', 'server.js',
    'main.py', 'app.py', 'manage.py', 'wsgi.py', 'asgi.py',
    'main.go', 'cmd/main.go', 'Program.cs', 'artisan', 'public/index.php',
    'src/main/java/Application.java',
  ];
  const found = candidates.filter((c) => paths.has(c));

  const pkg = manifests['package.json'];
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as { main?: string };
      if (parsed.main && !found.includes(parsed.main)) found.push(parsed.main);
    } catch {
      /* ignore malformed manifest */
    }
  }
  return found;
}

function detectScript(manifests: Record<string, string>, names: string[]): string | undefined {
  const pkg = manifests['package.json'];
  if (!pkg) return undefined;
  try {
    const parsed = JSON.parse(pkg) as { scripts?: Record<string, string> };
    for (const name of names) {
      if (parsed.scripts?.[name]) return `npm run ${name}`;
    }
  } catch {
    /* ignore malformed manifest */
  }
  return undefined;
}

function defaultTestCommand(languages: string[], paths: Set<string>): string | undefined {
  if (languages.includes('Python') && (paths.has('pytest.ini') || paths.has('pyproject.toml'))) return 'pytest';
  if (languages.includes('Go')) return 'go test ./...';
  if (paths.has('pom.xml')) return 'mvn test';
  if (paths.has('build.gradle')) return 'gradle test';
  if (paths.has('composer.json')) return 'composer test';
  return undefined;
}
