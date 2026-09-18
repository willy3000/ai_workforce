'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui';

/**
 * Route-level error boundary.
 *
 * The audit found no `error.tsx`, `loading.tsx` or `not-found.tsx` anywhere, so
 * a single failing panel took the whole workbench to a blank screen with a
 * generic Next.js message — and an operator watching a run lost the run.
 *
 * This keeps navigation available and offers the two recoveries that actually
 * work: retry this route, or go somewhere known-good.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Nothing is wired to an error-monitoring service yet, so the console is the
    // only place this survives. Kept deliberately — a swallowed error is worse
    // than a noisy one.
    // eslint-disable-next-line no-console
    console.error('Route error:', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg py-12 text-center">
      <span aria-hidden className="text-[22px]" style={{ color: 'var(--status-critical)' }}>
        ✕
      </span>
      <h1 className="mt-3 text-[16px] font-semibold">This screen failed to render</h1>
      <p className="mx-auto mt-2 max-w-sm text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        The rest of the console is still working, and any run in progress is unaffected — runs
        execute on the server, not in this tab.
      </p>

      <p className="hud mt-3 break-words text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {error.message}
        {error.digest && <> · {error.digest}</>}
      </p>

      <div className="mt-5 flex items-center justify-center gap-2.5">
        <Button variant="primary" size="sm" onClick={reset}>
          Try again
        </Button>
        <Link href="/" className="text-[12px] hover:underline" style={{ color: 'var(--text-muted)' }}>
          Back to the workspace
        </Link>
      </div>
    </div>
  );
}
