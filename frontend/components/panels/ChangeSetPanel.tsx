'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import type { RunRepoState, WorkflowRun } from '@/lib/types';

/**
 * The change a run produced, as evidence rather than narrative.
 *
 * The audit's central commercial finding was that the platform showed technical
 * activity but not delivered value: there was no authoritative diff, no test
 * verdict, and no guaranteed deliverable, so "did this work?" could only be
 * answered by reading an agent's own prose about itself.
 *
 * Every number on this panel is recorded by the platform from something it
 * observed — a commit it made, a command it ran and the exit code it got back, a
 * file a tool actually wrote. None of it is parsed out of model output. That
 * distinction is the difference between evidence and a claim, and it is why the
 * empty states here say "nothing was verified" rather than staying silent: an
 * absent check is information the reviewer needs.
 */
export function ChangeSetPanel({ run }: { run: WorkflowRun }) {
  const changeSet = run.changeSet;
  const [showAllPaths, setShowAllPaths] = useState(false);

  const paths = changeSet?.changedPaths ?? [];
  const checks = changeSet?.checks ?? [];
  const commits = changeSet?.commits ?? [];
  const passed = checks.filter((c) => c.passed).length;
  const published = (changeSet?.repos ?? []).some((r) => r.published);
  const allPassed = checks.length > 0 && passed === checks.length;

  const verificationColor = !checks.length
    ? 'var(--status-warning)'
    : allPassed
      ? 'var(--status-good)'
      : 'var(--status-critical)';

  return (
    <section className="panel p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold">What changed</h2>
        {changeSet?.branch && (
          <span className="hud truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {changeSet.branch}
          </span>
        )}
      </header>

      {/* Headline numbers. Three facts, each independently checkable. */}
      <div className="grid grid-cols-3 gap-2">
        <Metric label="Files" value={paths.length} hint="Files a tool actually wrote during this run" />
        <Metric label="Commits" value={commits.length} hint="Commits created by the workforce" />
        <Metric
          label="Checks"
          value={checks.length ? `${passed}/${checks.length}` : '—'}
          color={verificationColor}
          hint={
            checks.length
              ? `${passed} of ${checks.length} verification commands exited zero`
              : 'No test or lint command was run during this run'
          }
        />
      </div>

      {/* Verification is the load-bearing claim, so it gets the most space. */}
      <div className="mt-4">
        <p className="eyebrow mb-1.5">Verification</p>
        {!checks.length ? (
          <p
            className="rounded-md border px-2.5 py-2 text-[11.5px] leading-relaxed"
            style={{
              borderColor: 'color-mix(in srgb, var(--status-warning) 32%, transparent)',
              color: 'var(--status-warning)',
            }}
          >
            Nothing was verified. No test, lint or type-check command ran, so there is no evidence
            the change works — review it as unverified.
          </p>
        ) : (
          <ul className="space-y-1">
            {checks.map((check, index) => (
              <motion.li
                key={`${check.command}-${index}`}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.03 }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px]"
                style={{ background: 'var(--surface-0)' }}
              >
                <span
                  aria-hidden
                  style={{ color: check.passed ? 'var(--status-good)' : 'var(--status-critical)' }}
                >
                  {check.passed ? '✓' : '✕'}
                </span>
                <code className="hud min-w-0 flex-1 truncate">{check.command}</code>
                <span
                  className="hud shrink-0 text-[10.5px]"
                  style={{ color: check.passed ? 'var(--text-muted)' : 'var(--status-critical)' }}
                >
                  {check.passed ? 'pass' : `exit ${check.exitCode ?? '?'}`}
                </span>
              </motion.li>
            ))}
          </ul>
        )}
      </div>

      {/* Changed files. */}
      {paths.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-1.5">Files touched</p>
          <ul className="space-y-0.5">
            {(showAllPaths ? paths : paths.slice(0, 8)).map((path) => (
              <li key={path} className="hud truncate text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {path}
              </li>
            ))}
          </ul>
          {paths.length > 8 && (
            <button
              type="button"
              onClick={() => setShowAllPaths((v) => !v)}
              className="mt-1.5 text-[11px] underline underline-offset-2"
              style={{ color: 'var(--series-1)' }}
            >
              {showAllPaths ? 'Show fewer' : `Show all ${paths.length}`}
            </button>
          )}
        </div>
      )}

      {/* Commit range: the immutable base is what makes the diff answerable. */}
      {changeSet?.baseCommit && (
        <div className="mt-4">
          <p className="eyebrow mb-1.5">Commit range</p>
          <p className="hud text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {changeSet.baseCommit.slice(0, 10)}
            <span style={{ color: 'var(--text-muted)' }}> … </span>
            {(changeSet.headCommit ?? changeSet.baseCommit).slice(0, 10)}
          </p>
          <p className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
            Base pinned when the run claimed the checkout, so this range is exactly what the run did.
          </p>
        </div>
      )}

      {/* Where to try it: the run branch, per repository, with the command. */}
      {changeSet?.branch && (changeSet.repos?.length ?? 0) > 0 && (
        <TryIt branch={changeSet.branch} repos={changeSet.repos ?? []} />
      )}

      {/* The deliverable. */}
      <div className="mt-4 border-t pt-3">
        {changeSet?.pullRequest ? (
          <a
            href={changeSet.pullRequest.url}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-2 text-[12px] font-medium hover:underline"
            style={{ color: 'var(--series-1)' }}
          >
            <span aria-hidden>⑂</span>
            {changeSet.pullRequest.draft ? 'Draft pull request' : 'Pull request'} #
            {changeSet.pullRequest.number}
            <span aria-hidden>↗</span>
          </a>
        ) : published ? (
          <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--status-good)' }}>
            ✓ Published as a branch into your project — see “Try it” above.
          </p>
        ) : commits.length > 0 ? (
          <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Committed to <code className="hud">{changeSet?.branch ?? 'the working branch'}</code> but
            not published. Nothing has been pushed to the remote.
          </p>
        ) : paths.length > 0 ? (
          <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Changes are in the working tree and uncommitted. They live only on this server until
            something commits and publishes them.
          </p>
        ) : (
          <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            No files were changed. This run produced analysis only.
          </p>
        )}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: string | number;
  hint: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-0)' }} title={hint}>
      <p className="eyebrow">{label}</p>
      <p className="hud mt-0.5 text-[18px] font-semibold leading-none" style={{ color: color ?? 'var(--text-primary)' }}>
        {value}
      </p>
    </div>
  );
}

/**
 * "Where do I actually see it?" — answered on the run page.
 *
 * Each repository the run changed gets its published location and the exact
 * commands to check the branch out. A repository the run did not change says
 * so, and a failed publish says why, rather than leaving the operator to guess
 * whether the branch exists.
 */
function TryIt({ branch, repos }: { branch: string; repos: RunRepoState[] }) {
  const changed = repos.filter((r) => (r.changedPaths?.length ?? 0) > 0);

  return (
    <div className="mt-4">
      <p className="eyebrow mb-1.5">Try it</p>
      <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        The work is on branch <code className="hud" style={{ color: 'var(--text-primary)' }}>{branch}</code>.
        Your checked-out branch and uncommitted files were not touched.
      </p>

      <ul className="mt-2 space-y-2">
        {repos.map((repo) => {
          const files = repo.changedPaths?.length ?? 0;
          const name = repo.root || 'repository';
          if (!files) {
            return (
              <li key={repo.root} className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <span className="hud">{name}/</span> — no changes in this run, nothing published
              </li>
            );
          }
          return (
            <li key={repo.root} className="rounded-md px-2.5 py-2" style={{ background: 'var(--surface-0)' }}>
              <div className="flex items-center justify-between gap-2 text-[11.5px]">
                <span className="hud font-medium">{name}/</span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {files} file{files === 1 ? '' : 's'}
                  {repo.baselineCommit ? ' · on top of your uncommitted work' : ''}
                </span>
              </div>
              {repo.published ? (
                <CommandBlock
                  lines={[
                    `cd "${repo.published.target}"`,
                    'git stash push -u -m "before aiec"   # only if you have uncommitted changes',
                    `git checkout ${branch}`,
                  ]}
                />
              ) : (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--status-warning)' }}>
                  Not published{repo.publishError ? `: ${repo.publishError}` : ' yet — the run has not finished.'}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {changed.some((r) => r.baselineCommit) && (
        <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          The branch starts with a commit labelled “baseline” holding the uncommitted work you had
          when the run began — the agents built on it. The feature is the commit after it, so{' '}
          <code className="hud">git diff HEAD~1</code> on the branch shows only what the workforce did.
        </p>
      )}
    </div>
  );
}

function CommandBlock({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = lines.join('\n');
  return (
    <div className="relative mt-1.5">
      <pre
        className="hud overflow-x-auto rounded border px-2 py-1.5 pr-14 text-[10.5px] leading-relaxed"
        style={{ background: 'var(--surface-1)', color: 'var(--text-secondary)' }}
      >
        {text}
      </pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute right-1.5 top-1.5 rounded border px-1.5 py-0.5 text-[10px]"
        style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
        aria-label="Copy commands"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
