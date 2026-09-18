/**
 * Route-level loading state.
 *
 * Skeletons shaped like the workspace, not a spinner: the layout should not jump
 * when real content arrives, and a reader should be able to tell which screen is
 * loading before it finishes.
 */
export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="flex gap-2">
        <div className="skeleton h-7 w-28 rounded-full" />
        <div className="skeleton h-7 w-36 rounded-full" />
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
        <div className="skeleton h-[470px] rounded-xl" />
        <div className="space-y-5">
          <div className="skeleton h-40 rounded-xl" />
          <div className="skeleton h-64 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
