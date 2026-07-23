'use client';

import { useState } from 'react';
import type { Agent } from '@/lib/types';
import { agentColor } from '@/lib/design';

/**
 * The security posture, made visible.
 *
 * Encoding choice: this is a *state* matrix (allowed / denied / not-applicable),
 * not a magnitude — so it uses the reserved status palette with a glyph in every
 * cell. A reader in greyscale, or with colour-vision deficiency, still reads it
 * correctly from the glyph alone. A sequential ramp would have been wrong here:
 * "denied" is not a smaller amount of "allowed", it is a different kind.
 */

interface Capability {
  id: string;
  label: string;
  hint: string;
  evaluate: (a: Agent) => { state: 'yes' | 'no' | 'scoped'; detail: string };
}

const CAPABILITIES: Capability[] = [
  {
    id: 'read',
    label: 'Read repo',
    hint: 'Can inspect source files',
    evaluate: () => ({ state: 'yes', detail: 'Full read access (secrets always excluded)' }),
  },
  {
    id: 'write',
    label: 'Write files',
    hint: 'Can modify the repository',
    evaluate: (a) =>
      a.permissions.canWrite
        ? { state: 'scoped', detail: `Scoped to ${a.permissions.writePaths.length} path patterns` }
        : { state: 'no', detail: 'Read-only / advisory role — cannot modify any file' },
  },
  {
    id: 'terminal',
    label: 'Run commands',
    hint: 'Can execute allowlisted binaries',
    evaluate: (a) =>
      a.permissions.canRunCommands
        ? { state: 'scoped', detail: `Allowlist: ${a.permissions.allowedCommands.join(', ')}` }
        : { state: 'no', detail: 'Cannot execute any command' },
  },
  {
    id: 'git',
    label: 'Branch/commit',
    hint: 'Can create branches and commit',
    evaluate: (a) =>
      a.permissions.canWriteGit
        ? { state: 'yes', detail: 'Can branch and commit (PR creation is separately gated)' }
        : { state: 'no', detail: 'No version-control write access' },
  },
  {
    id: 'deploy',
    label: 'Deploy config',
    hint: 'Dockerfile, CI, infra',
    evaluate: (a) => {
      const denied = a.permissions.deniedPaths.some(
        (p) => p.includes('Dockerfile') || p.includes('.github') || p.includes('terraform') || p.includes('k8s'),
      );
      return denied
        ? { state: 'no', detail: 'Explicitly denied — deployment changes need a human' }
        : a.permissions.canWrite
          ? { state: 'no', detail: 'Not in write scope' }
          : { state: 'no', detail: 'Read-only role' };
    },
  },
  {
    id: 'secrets',
    label: 'Secrets',
    hint: '.env, keys, credentials',
    evaluate: () => ({ state: 'no', detail: 'Denied to every role, without exception' }),
  },
  {
    id: 'approval',
    label: 'Needs approval',
    hint: 'Human gate before running',
    evaluate: (a) =>
      a.permissions.requiresHumanApproval
        ? { state: 'yes', detail: 'A human must approve before this agent runs' }
        : { state: 'no', detail: 'Runs autonomously' },
  },
];

const CELL: Record<string, { color: string; glyph: string; label: string }> = {
  yes: { color: 'var(--status-good)', glyph: '✓', label: 'Allowed' },
  scoped: { color: 'var(--status-warning)', glyph: '◑', label: 'Scoped' },
  no: { color: 'var(--text-muted)', glyph: '✕', label: 'Denied' },
};

export function PermissionMatrix({ agents }: { agents: Agent[] }) {
  const [tip, setTip] = useState<{ agent: string; cap: string; detail: string } | null>(null);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-[var(--surface-1)] p-2 text-left font-medium text-[var(--text-secondary)]">
                Agent
              </th>
              {CAPABILITIES.map((c) => (
                <th key={c.id} className="p-2 text-center font-medium text-[var(--text-secondary)]">
                  <span title={c.hint}>{c.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.key} className="hover:bg-[var(--surface-2)]">
                <td className="sticky left-0 z-10 whitespace-nowrap border-t bg-[var(--surface-1)] p-2">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: agentColor(agent.key) }}
                    />
                    <span className="font-medium">{agent.name}</span>
                  </span>
                </td>
                {CAPABILITIES.map((cap) => {
                  const result = cap.evaluate(agent);
                  const style = CELL[result.state];
                  return (
                    <td
                      key={cap.id}
                      className="border-t p-2 text-center"
                      onMouseEnter={() =>
                        setTip({ agent: agent.name, cap: cap.label, detail: result.detail })
                      }
                      onMouseLeave={() => setTip(null)}
                    >
                      <span
                        className="inline-flex h-6 w-6 cursor-help items-center justify-center rounded-md border text-[11px] font-bold"
                        style={{ color: style.color, borderColor: style.color }}
                        title={`${style.label}: ${result.detail}`}
                        aria-label={`${cap.label}: ${style.label}`}
                      >
                        {style.glyph}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 text-[10px] text-[var(--text-muted)]">
        {Object.entries(CELL).map(([key, v]) => (
          <span key={key} className="flex items-center gap-1.5">
            <span
              className="inline-flex h-4 w-4 items-center justify-center rounded border text-[9px] font-bold"
              style={{ color: v.color, borderColor: v.color }}
              aria-hidden
            >
              {v.glyph}
            </span>
            {v.label}
          </span>
        ))}
      </div>

      <div className="mt-2 min-h-[36px] rounded-lg border bg-[var(--surface-2)] px-3 py-2">
        {tip ? (
          <p className="text-[11px] text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--text-primary)]">
              {tip.agent} · {tip.cap}
            </span>{' '}
            — {tip.detail}
          </p>
        ) : (
          <p className="text-[11px] text-[var(--text-muted)]">
            Enforced in code by the PermissionGuard, not by prompting — a write outside scope is
            rejected before it reaches the filesystem. Hover a cell for the specific rule.
          </p>
        )}
      </div>
    </div>
  );
}
