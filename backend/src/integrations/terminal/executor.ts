import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { redactSecrets } from '../../security/secret-paths';
import { PermissionDeniedError, ToolExecutionError } from '../../utils/errors';

/**
 * Command execution for agents.
 *
 * Security posture — commands originate from model output, so:
 *
 *  1. `shell: false`. The command and its arguments are passed as an argv array,
 *     so shell metacharacters (`;`, `&&`, backticks, `$( )`) have no meaning and
 *     command chaining is structurally impossible.
 *  2. Allowlist, not blocklist. The executable must appear in the calling
 *     agent's `allowedCommands`. A blocklist of "dangerous" commands is
 *     trivially bypassable and is not used.
 *  3. Hard timeout + output cap, and the whole process *tree* is killed on
 *     timeout or cancellation so a runaway test suite cannot hold a worker
 *     forever or outlive the run that started it.
 *  4. Fixed cwd inside the project workspace, and an **allowlisted** environment:
 *     the child receives only the variables named in `INHERITED_ENV_KEYS`.
 *
 * ## What this is not
 * The audit's S2 finding stands and is not closed by this file: `node`, `python`
 * and package managers are Turing-complete, so an allowlisted command can still
 * run arbitrary code *as this process's user, with this process's network
 * access*. The controls here reduce credential exposure and resource exhaustion;
 * genuine isolation requires running the child in a disposable sandbox with no
 * control-plane route and restricted egress. `TERMINAL_SANDBOX_COMMAND` is the
 * seam for that — when set, every command is executed through it — and
 * `ALLOW_UNSANDBOXED_COMMANDS` must be set explicitly to run without one in
 * production, so the unsafe configuration is a deliberate choice rather than the
 * default.
 *
 * Point 4 is the fix for audit finding S3: the previous deny list named five
 * secrets and therefore leaked `GEMINI_API_KEY` (absent from it) and every
 * credential added later. An allowlist fails closed for variables nobody has
 * thought about yet.
 */
export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

/**
 * The only variables a child process inherits.
 *
 * `PATH` and the platform/locale set are required for toolchains to resolve and
 * behave deterministically. Nothing here carries a credential; anything a build
 * genuinely needs must be added deliberately and reviewed as a policy change.
 */
const INHERITED_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'WINDIR',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  // Toolchain-local caches and version managers: not secrets, but builds are
  // dramatically slower or simply broken without them.
  'NODE_PATH',
  'NPM_CONFIG_CACHE',
  'NVM_DIR',
  'PYENV_ROOT',
  'VIRTUAL_ENV',
  'GOPATH',
  'GOCACHE',
  'GOMODCACHE',
  'JAVA_HOME',
  'GRADLE_USER_HOME',
  'MAVEN_OPTS',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'DOTNET_CLI_HOME',
  'NUGET_PACKAGES',
  // Windows profile locations. Not secrets, but npm resolves its global prefix
  // and cache from APPDATA/LOCALAPPDATA, and tools locate their own installs via
  // ProgramFiles. Omitting them made npm misbehave on Windows hosts.
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'SystemDrive',
  'HOMEDRIVE',
  'HOMEPATH',
];

export interface RunOptions {
  allowedCommands: string[];
  timeoutMs?: number;
  /** Aborting kills the process tree; used by run cancellation (audit E1). */
  signal?: AbortSignal;
}

export class TerminalExecutor {
  constructor(private readonly cwd: string) {}

  /** The environment a child will receive — exported so tests can assert on it. */
  static childEnv(): NodeJS.ProcessEnv {
    const childEnv: NodeJS.ProcessEnv = {};
    for (const key of INHERITED_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) childEnv[key] = value;
    }
    // Signals to test runners and installers that this is an automated context:
    // disables interactive prompts, colour codes and update notifiers.
    childEnv.CI = 'true';
    childEnv.NO_COLOR = '1';
    childEnv.npm_config_yes = 'true';
    childEnv.npm_config_update_notifier = 'false';
    return childEnv;
  }

  async run(command: string, args: string[], options: RunOptions): Promise<CommandResult> {
    const executable = command.trim();
    if (!executable) throw new ToolExecutionError('No command provided');

    if (!options.allowedCommands.includes(executable)) {
      throw new PermissionDeniedError(
        `Command '${executable}' is not in this agent's allowlist. Allowed: ${
          options.allowedCommands.join(', ') || '(none)'
        }`,
      );
    }
    if (/[;&|`$><\n]/.test(executable) || args.some((a) => typeof a !== 'string')) {
      throw new PermissionDeniedError('Command chaining and shell metacharacters are not permitted');
    }
    // A path separator in the executable name means the allowlist entry no longer
    // identifies what runs: `./node` and `node` are different programs.
    if (/[/\\]/.test(executable)) {
      throw new PermissionDeniedError(
        `Command '${executable}' must be a bare executable name resolved from PATH, not a path.`,
      );
    }
    if (options.signal?.aborted) {
      throw new ToolExecutionError('Run was cancelled before the command started', false);
    }

    const sandboxed = wrapInSandbox(executable, args, this.cwd);
    // Inside a sandbox the wrapper resolves the command in its own filesystem;
    // only a direct host spawn needs Windows shim resolution.
    const { executable: spawned, args: spawnArgs, verbatim } =
      sandboxed.executable !== executable || process.platform !== 'win32'
        ? { ...sandboxed, verbatim: false }
        : resolveWindowsCommand(executable, args);
    const timeoutMs = options.timeoutMs ?? env.TERMINAL_TIMEOUT_MS;
    const startedAt = Date.now();

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(spawned, spawnArgs, {
        cwd: this.cwd,
        env: TerminalExecutor.childEnv(),
        shell: false,
        windowsHide: true,
        // Only set for the cmd.exe path below, whose command line is built and
        // validated by `resolveWindowsCommand` rather than escaped by Node.
        windowsVerbatimArguments: verbatim,
        // A detached child becomes its own process-group leader, which is what
        // makes killing the *tree* possible below. The previous code's comment
        // promised process-group termination while `child.kill()` signalled only
        // the direct child, so `npm test` died and the test runner it spawned
        // did not (audit: "comments promise process-group termination but code
        // kills one child").
        detached: process.platform !== 'win32',
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const cap = env.TERMINAL_MAX_OUTPUT;

      const killTree = (): void => {
        if (child.pid === undefined) return;
        try {
          if (process.platform === 'win32') {
            // Windows has no process groups; taskkill /T walks the child tree.
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            }).on('error', () => child.kill('SIGKILL'));
          } else {
            // Negative pid targets the whole process group created by `detached`.
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          // Already gone, or we lost the race with a normal exit. Either way the
          // `close` handler below settles the promise.
          try {
            child.kill('SIGKILL');
          } catch {
            /* nothing left to kill */
          }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);

      const onAbort = (): void => {
        cancelled = true;
        killTree();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < cap) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < cap) stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new ToolExecutionError(`Failed to start '${executable}': ${err.message}`));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        const result: CommandResult = {
          command: executable,
          args,
          exitCode: code,
          // Command output can echo a token the build printed; redact before it
          // reaches a transcript, an artifact or a log (audit finding S11).
          stdout: redactSecrets(stdout.slice(0, cap)),
          stderr: redactSecrets(stderr.slice(0, cap)),
          timedOut,
          cancelled,
          durationMs: Date.now() - startedAt,
        };
        logger.debug(
          { command: executable, exitCode: code, timedOut, cancelled, durationMs: result.durationMs },
          'Terminal command finished',
        );
        resolve(result);
      });
    });
  }
}

/**
 * Route the command through the configured sandbox, if any.
 *
 * `TERMINAL_SANDBOX_COMMAND` is an argv template such as
 * `docker run --rm --network none -v {cwd}:/w -w /w node:22-alpine` — the agent's
 * command is appended to it. Leaving it unset runs commands directly in the API
 * host, which `env.ts` refuses to allow in production unless
 * `ALLOW_UNSANDBOXED_COMMANDS=true` is set explicitly.
 */
function wrapInSandbox(
  executable: string,
  args: string[],
  cwd: string,
): { executable: string; args: string[] } {
  const template = env.TERMINAL_SANDBOX_COMMAND.trim();
  if (!template) return { executable, args };

  // The template is operator-configured, never model-supplied, so splitting on
  // whitespace is adequate — it is not parsing untrusted input.
  const parts = template
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.replaceAll('{cwd}', cwd));
  const [sandboxExecutable, ...sandboxArgs] = parts;
  if (!sandboxExecutable) return { executable, args };
  return { executable: sandboxExecutable, args: [...sandboxArgs, executable, ...args] };
}

/**
 * Resolve an allowlisted command to something `spawn` can start on Windows.
 *
 * ## The bug this fixes
 * On Windows `npm`, `npx`, `pnpm` and `yarn` are `.cmd` batch shims, and
 * `spawn('npm', { shell: false })` cannot start a batch file — it fails with
 * `spawn npm ENOENT`. Agents reported that as "npm is not available in the
 * environment" and blocked, although npm was installed. `node` worked only
 * because it is a real `.exe`.
 *
 * ## Without reopening shell injection
 * Setting `shell: true` would "fix" it by letting the model's arguments be
 * interpreted by cmd.exe. Instead, in order of preference:
 *
 *  1. `npm` / `npx` run as `node <npm-cli.js>` — no shell involved at all.
 *  2. A real executable (`.exe`/`.com`) found on PATH is spawned by full path.
 *  3. Any other batch shim runs via `cmd.exe /d /s /c` with a command line built
 *     here, and every argument is rejected if it contains a character cmd.exe
 *     would interpret. A legitimate package name, script or flag never needs one.
 */
export function resolveWindowsCommand(
  executable: string,
  args: string[],
  lookup: { path?: string; pathExt?: string; nodeDir?: string; exists?: (p: string) => boolean } = {},
): { executable: string; args: string[]; verbatim: boolean } {
  const exists = lookup.exists ?? ((p: string) => fsSync.existsSync(p));
  const nodeDir = lookup.nodeDir ?? path.dirname(process.execPath);
  const searchPath = lookup.path ?? process.env.PATH ?? process.env.Path ?? '';
  const pathExt = (lookup.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const dirs = [nodeDir, ...searchPath.split(';').filter(Boolean)];

  // 1. npm and npx ship as JavaScript entry points beside their shims.
  if (executable === 'npm' || executable === 'npx') {
    const script = `${executable}-cli.js`;
    for (const dir of dirs) {
      const candidate = path.join(dir, 'node_modules', 'npm', 'bin', script);
      if (exists(candidate)) return { executable: process.execPath, args: [candidate, ...args], verbatim: false };
    }
  }

  // 2 & 3. Search PATH × PATHEXT, preferring real executables over shims.
  let shim: string | undefined;
  for (const dir of dirs) {
    for (const ext of pathExt) {
      const candidate = path.join(dir, `${executable}${ext}`);
      if (!exists(candidate)) continue;
      if (ext === '.exe' || ext === '.com') return { executable: candidate, args, verbatim: false };
      shim ??= candidate;
    }
  }

  if (!shim) {
    throw new ToolExecutionError(
      `'${executable}' is allowed for this agent but is not installed on the platform host ` +
        '(not found on PATH). Tell the operator which tool is missing rather than working around it.',
      false,
    );
  }

  const unsafe = args.find((a) => /["%!^&|<>\r\n]/.test(a));
  if (unsafe !== undefined) {
    throw new PermissionDeniedError(
      `Argument '${unsafe}' contains a character the Windows command interpreter would act on ` +
        '(" % ! ^ & | < > or a newline). Pass plain arguments only.',
    );
  }
  const quote = (a: string) => `"${a}"`;
  const commandLine = [shim, ...args].map(quote).join(' ');
  const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
  return { executable: comspec, args: ['/d', '/s', '/c', `"${commandLine}"`], verbatim: true };
}
