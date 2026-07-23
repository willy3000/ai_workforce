'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePoll } from '@/lib/hooks';
import { statusStyle } from '@/lib/design';

const NAV = [
  { href: '/', label: 'Command Center', glyph: '◉' },
  { href: '/org', label: 'The Org', glyph: '⬡' },
  { href: '/projects', label: 'Projects', glyph: '▤' },
  { href: '/runs', label: 'Workflow Runs', glyph: '⟳' },
  { href: '/pipeline', label: 'Data Pipeline', glyph: '⇄' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const ready = usePoll(() => api.ready(), 15_000);

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r bg-[var(--surface-1)] p-3 lg:flex">
        <div className="mb-6 px-2 pt-2">
          <p className="text-sm font-semibold leading-tight">AI Engineering</p>
          <p className="text-sm font-semibold leading-tight text-[var(--series-1)]">Company</p>
          <p className="mt-1 text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
            Autonomous workforce
          </p>
        </div>

        <nav className="flex flex-col gap-0.5">
          {NAV.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                  active
                    ? 'bg-[var(--surface-2)] font-medium text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <span
                  aria-hidden
                  className="text-xs"
                  style={{ color: active ? 'var(--series-1)' : 'var(--text-muted)' }}
                >
                  {item.glyph}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto space-y-2">
          <PlatformHealth ready={ready.data} error={ready.error} />
          <ThemeToggle />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b bg-[var(--surface-1)]/95 px-4 py-2.5 backdrop-blur lg:px-6">
          <nav className="flex gap-1 lg:hidden">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                className="rounded-md px-2 py-1 text-xs text-[var(--text-secondary)]"
              >
                {item.glyph}
              </Link>
            ))}
          </nav>
          <p className="hidden text-xs text-[var(--text-muted)] lg:block">
            {NAV.find((n) => (n.href === '/' ? pathname === '/' : pathname.startsWith(n.href)))?.label ??
              'Dashboard'}
          </p>
          <LiveIndicator />
        </header>

        <main className="min-w-0 flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}

/**
 * Platform health in the sidebar.
 *
 * This is the panel that tells you *why* an agent run will fail before you
 * start one — a missing Claude key or an unreachable database shows here rather
 * than as a stack trace three steps into a workflow.
 */
function PlatformHealth({
  ready,
  error,
}: {
  ready: {
    status: string;
    checks: Record<string, boolean>;
    providers?: { effective: string; configured: string[]; models: Record<string, string> };
    config?: { model: string; requireHumanApproval: boolean };
  } | null;
  error: string | null;
}) {
  if (error) {
    const s = statusStyle('failed');
    return (
      <div className="rounded-lg border px-2.5 py-2" style={{ borderColor: s.color }}>
        <p className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: s.color }}>
          <span aria-hidden>{s.glyph}</span> Backend offline
        </p>
        <p className="mt-1 text-[10px] leading-snug text-[var(--text-muted)]">
          Start it with <code>npm run dev</code> in ./backend
        </p>
      </div>
    );
  }
  if (!ready) return <div className="skeleton h-16 rounded-lg" />;

  const checks = [
    { key: 'database', label: 'MongoDB' },
    { key: 'claudeApiKey', label: 'Claude key' },
    { key: 'geminiApiKey', label: 'Gemini key' },
    { key: 'githubToken', label: 'GitHub' },
  ];

  return (
    <div className="rounded-lg border bg-[var(--surface-2)] px-2.5 py-2">
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
        Platform
      </p>
      <ul className="space-y-1">
        {checks.map((c) => {
          const ok = ready.checks?.[c.key];
          const s = statusStyle(ok ? 'done' : 'failed');
          return (
            <li key={c.key} className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--text-secondary)]">{c.label}</span>
              <span className="flex items-center gap-1" style={{ color: s.color }}>
                <span aria-hidden>{s.glyph}</span>
                {ok ? 'ok' : 'off'}
              </span>
            </li>
          );
        })}
      </ul>
      {/*
        Which provider is actually answering. Shown always, not only on
        mismatch: "which model wrote this code?" should never require reading
        the server logs.
      */}
      {ready.providers && (
        <div className="mt-1.5 border-t pt-1.5">
          <p className="flex items-center justify-between text-[10px]">
            <span className="text-[var(--text-secondary)]">Model</span>
            <span
              className="font-medium"
              style={{
                color:
                  ready.providers.effective === 'claude' ? 'var(--series-1)' : 'var(--series-6)',
              }}
            >
              {ready.providers.effective}
            </span>
          </p>
          <p className="mt-0.5 truncate text-[9px] text-[var(--text-muted)]">
            {ready.providers.models?.[ready.providers.effective] ?? ''}
          </p>
        </div>
      )}
      {ready.config?.requireHumanApproval && (
        <p className="mt-1.5 border-t pt-1.5 text-[10px]" style={{ color: 'var(--status-warning)' }}>
          ⏸ Approval gates ON
        </p>
      )}
    </div>
  );
}

function LiveIndicator() {
  const [beat, setBeat] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setBeat((b) => !b), 2000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full transition-opacity"
        style={{ background: 'var(--status-good)', opacity: beat ? 1 : 0.35 }}
      />
      Live · polling
    </span>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem('aiec-theme') as 'light' | 'dark' | null;
    if (stored) {
      setTheme(stored);
      document.documentElement.setAttribute('data-theme', stored);
    }
  }, []);

  const toggle = () => {
    const next =
      theme === 'dark'
        ? 'light'
        : theme === 'light'
          ? 'dark'
          : window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'light'
            : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    window.localStorage.setItem('aiec-theme', next);
  };

  return (
    <button
      onClick={toggle}
      className="w-full rounded-lg border bg-[var(--surface-2)] px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
    >
      {theme === 'dark' ? '☾ Dark' : theme === 'light' ? '☀ Light' : '◐ System'} theme
    </button>
  );
}
