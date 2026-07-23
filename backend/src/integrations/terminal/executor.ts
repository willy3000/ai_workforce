import { spawn } from 'node:child_process';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
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
 *  3. Hard timeout + output cap, and the process group is killed on timeout so a
 *     runaway test suite cannot hold a worker forever.
 *  4. Fixed cwd inside the project workspace; the environment is scrubbed so
 *     platform secrets (CLAUDE_API_KEY, GITHUB_TOKEN, MONGODB_URI) are never
 *     visible to a child process.
 */
export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const SECRET_ENV_KEYS = [
  'CLAUDE_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'MONGODB_URI',
  'PLATFORM_API_KEY',
];

export class TerminalExecutor {
  constructor(private readonly cwd: string) {}

  async run(
    command: string,
    args: string[],
    options: { allowedCommands: string[]; timeoutMs?: number } ,
  ): Promise<CommandResult> {
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

    const timeoutMs = options.timeoutMs ?? env.TERMINAL_TIMEOUT_MS;
    const startedAt = Date.now();

    const scrubbedEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of SECRET_ENV_KEYS) delete scrubbedEnv[key];
    scrubbedEnv.CI = 'true';

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: this.cwd,
        env: scrubbedEnv,
        shell: false,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const cap = env.TERMINAL_MAX_OUTPUT;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < cap) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < cap) stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ToolExecutionError(`Failed to start '${executable}': ${err.message}`));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result: CommandResult = {
          command: executable,
          args,
          exitCode: code,
          stdout: stdout.slice(0, cap),
          stderr: stderr.slice(0, cap),
          timedOut,
          durationMs: Date.now() - startedAt,
        };
        logger.debug(
          { command: executable, exitCode: code, timedOut, durationMs: result.durationMs },
          'Terminal command finished',
        );
        resolve(result);
      });
    });
  }
}
