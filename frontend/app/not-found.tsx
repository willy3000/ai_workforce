import Link from 'next/link';

/**
 * Not found.
 *
 * Reached by a bad URL and — more usefully — by a run or project that has been
 * deleted while someone still had its link open. The copy names that case
 * explicitly, because "404" does not tell an operator whether they mistyped
 * something or whether their work is gone.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg py-12 text-center">
      <span aria-hidden className="text-[22px]" style={{ color: 'var(--text-muted)' }}>
        ○
      </span>
      <h1 className="mt-3 text-[16px] font-semibold">Nothing here</h1>
      <p className="mx-auto mt-2 max-w-sm text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        This address does not match a page, or the run or project it pointed at has been
        disconnected.
      </p>
      <div className="mt-5 flex items-center justify-center gap-4 text-[12px]">
        <Link href="/" className="hover:underline" style={{ color: 'var(--series-1)' }}>
          Workspace
        </Link>
        <Link href="/runs" className="hover:underline" style={{ color: 'var(--text-muted)' }}>
          All runs
        </Link>
        <Link href="/projects" className="hover:underline" style={{ color: 'var(--text-muted)' }}>
          Projects
        </Link>
      </div>
    </div>
  );
}
