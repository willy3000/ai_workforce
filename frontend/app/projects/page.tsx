'use client';

import Link from 'next/link';
import { api } from '@/lib/api';
import { usePoll } from '@/lib/hooks';
import { formatBytes, timeAgo } from '@/lib/format';
import { Badge, Card, EmptyState, ErrorNote, SectionTitle, Spinner, StatusPill } from '@/components/ui';
import { ConnectProject } from '@/components/panels/ConnectProject';

export default function ProjectsPage() {
  const projects = usePoll(() => api.listProjects(), 6000);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Projects</h1>
        <p className="text-xs text-[var(--text-muted)]">
          Any repository, any language. Onboarding clones it, indexes every file, detects the stack,
          and seeds long-term memory — all from one call.
        </p>
      </div>

      <div>
        <SectionTitle title="Connect a repository" />
        <ConnectProject onConnected={projects.refresh} />
      </div>

      <div>
        <SectionTitle title="Connected projects" />
        {projects.error ? (
          <ErrorNote message={projects.error} onRetry={projects.refresh} />
        ) : !projects.data ? (
          <Card><Spinner /></Card>
        ) : !projects.data.projects.length ? (
          <EmptyState
            title="No projects connected"
            hint="Connect a GitHub repository above, or point the platform at a local directory if you would rather not use a token."
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {projects.data.projects.map((p) => (
              <Link key={p._id} href={`/projects/${p._id}`}>
                <Card className="h-full transition-colors hover:border-[var(--border-strong)]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                        {p.profile.fileCount > 0
                          ? `${p.profile.fileCount} files · ${formatBytes(p.profile.totalBytes)}`
                          : 'not indexed yet'}
                        {p.lastAnalyzedAt && ` · analysed ${timeAgo(p.lastAnalyzedAt)}`}
                      </p>
                    </div>
                    <StatusPill status={p.status === 'ready' ? 'done' : p.status} size="xs" />
                  </div>

                  {p.error && (
                    <p className="mt-2 text-[11px]" style={{ color: 'var(--status-critical)' }}>
                      {p.error}
                    </p>
                  )}

                  {p.status === 'ready' && (
                    <>
                      <div className="mt-2.5 flex flex-wrap gap-1">
                        {p.profile.languages.slice(0, 3).map((l) => (
                          <Badge key={l} color="var(--series-1)">{l}</Badge>
                        ))}
                        {p.profile.frameworks.slice(0, 3).map((f) => (
                          <Badge key={f} color="var(--series-2)">{f}</Badge>
                        ))}
                        {p.profile.database !== 'none detected' && (
                          <Badge color="var(--series-5)">{p.profile.database.split(',')[0]}</Badge>
                        )}
                      </div>
                      <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
                        <Row label="Architecture" value={p.profile.architecture} />
                        <Row label="Testing" value={p.profile.testingFramework} />
                        <Row label="Deployment" value={p.profile.deployment} />
                        <Row label="Test command" value={p.profile.testCommand ?? 'unknown'} />
                      </dl>
                    </>
                  )}
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="truncate text-[var(--text-secondary)]" title={value}>{value}</dd>
    </>
  );
}
