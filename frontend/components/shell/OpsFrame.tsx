'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '@/lib/api';
import { usePoll } from '@/lib/hooks';
import type { ReadyState } from '@/lib/types';

/**
 * The operations frame.
 *
 * ## No chrome
 * There is no sidebar and no header. The workspace fills the viewport and this
 * floats over it: a corner identity block, a corner vitals readout, and a small
 * dock. That is the whole point of the redesign — a sidebar-plus-header-plus-
 * cards layout is the generic-dashboard anti-pattern, and wrapping a canvas in
 * one just puts the anti-pattern around the good part.
 *
 * Everything here is anchored to a corner, translucent, and small. It is
 * instrumentation over a world, not furniture around a document.
 *
 * ## Honest instrumentation
 * The connection light is derived from actual poll outcomes, never from a timer.
 * The audit found an indicator that pulsed confidently green while the backend
 * was unreachable; a status light that cannot report bad news is worse than
 * none, because it actively misleads.
 */

const DOCK = [
  { href: '/', label: 'Workspace', glyph: '◉', exact: true },
  { href: '/runs', label: 'Missions', glyph: '⟳', exact: false },
  { href: '/projects', label: 'Repositories', glyph: '▤', exact: false },
  { href: '/org', label: 'Roster', glyph: '⬡', exact: false },
  { href: '/pipeline', label: 'Internals', glyph: '⇄', exact: false },
];

export function OpsFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const ready = usePoll<ReadyState>((signal) => api.ready(signal), { intervalMs: 15_000 });
  const runs = usePoll((signal) => api.listRuns(undefined, signal), { intervalMs: 20_000 });

  const needsYou =
    runs.data?.runs.filter((r) => r.status === 'awaiting_approval' || r.status === 'interrupted')
      .length ?? 0;

  // The workspace owns the whole viewport; other routes are documents and get a
  // scrolling container with breathing room.
  const isWorkspace = pathname === '/';

  return (
    <div className="relative h-dvh w-dvw overflow-hidden" style={{ background: 'var(--surface-0)' }}>
      <main
        id="main"
        className={
          isWorkspace
            ? 'absolute inset-0'
            : 'ops-field absolute inset-0 overflow-y-auto px-4 pb-24 pt-20 sm:px-8 lg:px-14'
        }
      >
        {isWorkspace ? children : <div className="mx-auto max-w-6xl">{children}</div>}
      </main>

      <Identity />
      <Instruments ready={ready.data} connection={connectionOf(ready)} needsYou={needsYou} />
      <Dock pathname={pathname} needsYou={needsYou} />
    </div>
  );
}

type Connection = { state: 'connected' | 'reconnecting' | 'offline'; detail: string };

function connectionOf(poll: {
  error: string | null;
  failures: number;
  updatedAt: number | null;
}): Connection {
  if (poll.failures >= 3) {
    return {
      state: 'offline',
      detail: 'Backend unreachable. Start it with `npm run dev` in ./backend.',
    };
  }
  if (poll.error) {
    return {
      state: 'reconnecting',
      detail: `Retrying — ${poll.failures} failed ${poll.failures === 1 ? 'attempt' : 'attempts'}`,
    };
  }
  if (!poll.updatedAt) return { state: 'reconnecting', detail: 'Connecting…' };
  return { state: 'connected', detail: 'Receiving updates' };
}

/** Top-left: who this is. Small, quiet, always present. */
function Identity() {
  return (
    <Link
      href="/"
      className="pointer-events-auto absolute left-5 top-5 z-20 flex items-center gap-2.5"
      aria-label="AI Engineering Company — workspace"
    >
      <Mark />
      <span className="hidden leading-none sm:block">
        <span className="block text-[12.5px] font-semibold tracking-tight">AI Engineering</span>
        <span className="eyebrow block pt-1">Autonomous workforce</span>
      </span>
    </Link>
  );
}

/**
 * Satellite positions, precomputed and rounded.
 *
 * Computing these inline with `Math.cos` caused a real hydration mismatch: the
 * server and the client serialise the last digit of a float differently
 * (`5.718847050625473` vs `5.718847050625472`), and React treats that as a
 * changed attribute. Rounding to a precision the renderer can reproduce exactly
 * makes the markup deterministic — which is the actual fix, rather than
 * suppressing the warning.
 */
const MARK_SATELLITES = [0, 72, 144, 216, 288].map((deg) => ({
  deg,
  cx: Number((13 + Math.cos((deg * Math.PI) / 180) * 8.6).toFixed(3)),
  cy: Number((13 + Math.sin((deg * Math.PI) / 180) * 8.6).toFixed(3)),
}));

function Mark() {
  return (
    <svg width="24" height="24" viewBox="0 0 26 26" aria-hidden className="shrink-0">
      <circle cx="13" cy="13" r="11.5" fill="none" stroke="var(--border-strong)" strokeWidth="1" />
      <circle cx="13" cy="13" r="3.6" fill="var(--series-2)" />
      {MARK_SATELLITES.map((s) => (
        <circle key={s.deg} cx={s.cx} cy={s.cy} r="1.9" fill="var(--series-1)" opacity={0.7} />
      ))}
    </svg>
  );
}

/**
 * Top-right: the readouts that change what to expect from the next run.
 *
 * Which model answers, how loaded the instance is, whether approval gates are
 * on, and whether agent commands are isolated. The audit's point was that a
 * missing key or an unsafe posture should be visible before a run starts, not
 * discovered three steps in.
 */
function Instruments({
  ready,
  connection,
  needsYou,
}: {
  ready: ReadyState | null;
  connection: Connection;
  needsYou: number;
}) {
  const router = useRouter();

  return (
    <div className="pointer-events-auto absolute right-5 top-5 z-20 flex items-center gap-2.5">
      <AnimatePresence>
        {needsYou > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
          >
            <Link
              href="/runs"
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium backdrop-blur-sm"
              style={{
                color: 'var(--status-warning)',
                background: 'color-mix(in srgb, var(--status-warning) 14%, transparent)',
                border: '1px solid color-mix(in srgb, var(--status-warning) 32%, transparent)',
              }}
            >
              <span aria-hidden>⏸</span>
              {needsYou} waiting
            </Link>
          </motion.div>
        )}
      </AnimatePresence>

      {ready && (
        <div className="hidden items-center gap-3 md:flex">
          {ready.providers?.effective && (
            <Readout
              label="model"
              value={ready.providers.effective}
              title={ready.providers.models?.[ready.providers.effective] ?? ''}
            />
          )}
          {ready.limits && (
            <Readout
              label="load"
              value={`${ready.limits.activeRuns}/${ready.limits.maxConcurrentRuns}`}
              accent={ready.limits.activeRuns > 0 ? 'var(--series-1)' : undefined}
              title="Runs executing now, against this instance's concurrency cap"
            />
          )}
          {ready.config?.requireHumanApproval && (
            <Chip color="var(--status-warning)" glyph="⏸" label="gated" title="Every mutating step pauses for approval" />
          )}
          {ready.security && !ready.security.commandsSandboxed && (
            <Chip
              color="var(--status-serious)"
              glyph="⚠"
              label="unsandboxed"
              title="Agent commands run in the API host. Set TERMINAL_SANDBOX_COMMAND to isolate them."
            />
          )}
        </div>
      )}

      <ConnectionLight connection={connection} />
      <ThemeToggle />

      <button
        type="button"
        onClick={async () => {
          await api.signOut();
          router.push('/login');
          router.refresh();
        }}
        className="rounded-md border px-2 py-1 text-[11px] backdrop-blur-sm transition-colors hover:text-[var(--text-primary)]"
        style={{ color: 'var(--text-muted)', background: 'color-mix(in srgb, var(--surface-1) 65%, transparent)' }}
        title="Sign out"
      >
        Exit
      </button>
    </div>
  );
}

function Readout({
  label,
  value,
  accent,
  title,
}: {
  label: string;
  value: string;
  accent?: string;
  title?: string;
}) {
  return (
    <span className="hud flex items-center gap-1.5 text-[11px]" title={title}>
      <span className="eyebrow">{label}</span>
      <span style={{ color: accent ?? 'var(--text-secondary)' }}>{value}</span>
    </span>
  );
}

function Chip({
  color,
  glyph,
  label,
  title,
}: {
  color: string;
  glyph: string;
  label: string;
  title: string;
}) {
  return (
    <span
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}
      title={title}
    >
      <span aria-hidden>{glyph}</span>
      {label}
    </span>
  );
}

function ConnectionLight({ connection }: { connection: Connection }) {
  const color = {
    connected: 'var(--status-good)',
    reconnecting: 'var(--status-warning)',
    offline: 'var(--status-critical)',
  }[connection.state];

  return (
    <span
      className="flex items-center gap-1.5 text-[11px]"
      style={{ color: connection.state === 'connected' ? 'var(--text-muted)' : color }}
      title={connection.detail}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inset-0 rounded-full" style={{ background: color }} />
        {connection.state === 'connected' && (
          <motion.span
            className="absolute inset-0 rounded-full"
            style={{ background: color }}
            animate={{ scale: [1, 2.4], opacity: [0.5, 0] }}
            transition={{ duration: 2.6, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
      </span>
      <span className="hidden lg:inline">
        {{ connected: 'Live', reconnecting: 'Reconnecting', offline: 'Offline' }[connection.state]}
      </span>
    </span>
  );
}

/**
 * The dock: a floating pill, bottom-left on desktop and bottom-centre on mobile.
 *
 * Labels are always present rather than revealed on hover — the audit found
 * glyph-only mobile navigation, which is unusable for anyone who has not already
 * memorised the icons.
 */
function Dock({ pathname, needsYou }: { pathname: string; needsYou: number }) {
  return (
    <nav
      aria-label="Primary"
      className="pointer-events-auto absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full border p-1 backdrop-blur-md lg:left-5 lg:translate-x-0"
      style={{
        background: 'color-mix(in srgb, var(--surface-1) 82%, transparent)',
        boxShadow: 'var(--elev-2)',
      }}
    >
      {DOCK.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className="relative flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11.5px] transition-colors"
            style={{ color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}
          >
            {active && (
              <motion.span
                layoutId="dock-active"
                className="absolute inset-0 rounded-full"
                style={{ background: 'var(--surface-2)' }}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              />
            )}
            <span aria-hidden className="relative text-[11px]" style={{ color: active ? 'var(--series-1)' : 'inherit' }}>
              {item.glyph}
            </span>
            <span className="relative hidden sm:inline">{item.label}</span>
            {item.href === '/runs' && needsYou > 0 && (
              <span
                aria-hidden
                className="relative h-1.5 w-1.5 rounded-full"
                style={{ background: 'var(--status-warning)' }}
              />
            )}
          </Link>
        );
      })}
    </nav>
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
      className="rounded-md border px-2 py-1 text-[11px] backdrop-blur-sm transition-colors hover:text-[var(--text-primary)]"
      style={{ color: 'var(--text-muted)', background: 'color-mix(in srgb, var(--surface-1) 65%, transparent)' }}
      aria-label={`Switch theme (currently ${theme ?? 'system'})`}
      title={`Theme: ${theme ?? 'system'}`}
    >
      {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
    </button>
  );
}
