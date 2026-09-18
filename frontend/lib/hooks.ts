'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Data-fetching hooks.
 *
 * The polling hook carries most of the correctness weight in this app, because
 * every live screen is built on it. The audit found four problems in the
 * original, all of which show up as "the dashboard lied to me":
 *
 *  1. **Overlapping requests.** `setInterval` fired regardless of whether the
 *     previous request had returned, so a slow response could land *after* a
 *     newer one and overwrite fresh data with stale data.
 *  2. **No abort.** Cleanup prevented the state write but left the request in
 *     flight, so navigating between projects left work running for screens
 *     nobody was looking at.
 *  3. **No backoff.** A backend that was down got hit at full rate forever.
 *  4. **No staleness signal.** A failed refresh left the last good data on
 *     screen with nothing to say it was old, so a run that had moved on looked
 *     like a run that had stalled.
 */

export interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** When the last *successful* fetch completed. Null until the first one. */
  updatedAt: number | null;
  /** True when showing previous data after a failed refresh. */
  stale: boolean;
  /** Consecutive failures — drives the reconnecting/offline indicator. */
  failures: number;
  refresh: () => void;
}

export interface PollOptions {
  /** 0 disables polling (one-shot fetch). */
  intervalMs?: number;
  /** Stop polling entirely — e.g. once a run reaches a terminal state. */
  paused?: boolean;
  /** Ceiling for exponential backoff after failures. */
  maxIntervalMs?: number;
}

export function usePoll<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: PollOptions | number = {},
  deps: unknown[] = [],
): PollState<T> {
  const { intervalMs = 4000, paused = false, maxIntervalMs = 60_000 } =
    typeof options === 'number' ? { intervalMs: options } : options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // One in-flight request per hook instance. Holding the controller in a ref
  // rather than in state means starting a new request can cancel the previous
  // one synchronously, before React would have re-rendered.
  const inFlight = useRef<AbortController | null>(null);
  const failureRef = useRef(0);

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async (): Promise<void> => {
      // Skip while the tab is hidden: a dashboard left open overnight should not
      // hammer the backend, and by extension should not keep an agent-bearing
      // API warm for nobody.
      if (typeof document !== 'undefined' && document.hidden) return schedule();

      // Single-flight: abandon any request still running before starting another,
      // so an older response can never resolve after a newer one.
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      try {
        const result = await fetcherRef.current(controller.signal);
        if (disposed || controller.signal.aborted) return;
        setData(result);
        setError(null);
        setUpdatedAt(Date.now());
        failureRef.current = 0;
        setFailures(0);
      } catch (err) {
        if (disposed || controller.signal.aborted) return;
        // An aborted request is a cancellation, not a failure — counting it
        // would back off every time the user changed screens.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        failureRef.current += 1;
        setFailures(failureRef.current);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!disposed && !controller.signal.aborted) setLoading(false);
        schedule();
      }
    };

    const schedule = (): void => {
      if (disposed || intervalMs <= 0 || paused) return;
      // Exponential backoff on consecutive failures, capped. A backend that is
      // down gets progressively left alone instead of being hammered.
      const delay = Math.min(intervalMs * 2 ** Math.min(failureRef.current, 5), maxIntervalMs);
      timer = setTimeout(() => void run(), delay);
    };

    void run();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      // Abort rather than merely ignoring: the request itself should stop.
      inFlight.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, paused, maxIntervalMs, tick, ...deps]);

  // Refresh promptly when the operator comes back to the tab, so returning to a
  // dashboard never shows data frozen at the moment they left.
  useEffect(() => {
    const onVisible = (): void => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh]);

  return {
    data,
    error,
    loading,
    updatedAt,
    stale: error !== null && data !== null,
    failures,
    refresh,
  };
}

/** Persist a value in localStorage (used for the selected project + theme). */
export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      /* ignore corrupt storage */
    }
  }, [key]);

  const update = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage full or blocked — non-fatal */
      }
    },
    [key],
  );

  return [value, update];
}

export interface ActionState<TArgs extends unknown[], TResult> {
  execute: (...args: TArgs) => Promise<TResult | null>;
  pending: boolean;
  error: string | null;
  /** The last successful result, for showing confirmation without a refetch. */
  result: TResult | null;
  clearError: () => void;
  reset: () => void;
}

/**
 * Run a mutation with pending/error state, for buttons that call the API.
 *
 * The audit noted the original captured `fn` in an empty-dependency callback,
 * which works only while every call site passes a stable function — a latent
 * staleness bug waiting for the first inline closure. A ref keeps the latest
 * function without making `execute` itself unstable, so callers can still put it
 * in dependency arrays.
 */
export function useAction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
): ActionState<TArgs, TResult> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TResult | null>(null);

  const fnRef = useRef(fn);
  fnRef.current = fn;

  const execute = useCallback(async (...args: TArgs): Promise<TResult | null> => {
    setPending(true);
    setError(null);
    try {
      const value = await fnRef.current(...args);
      setResult(value);
      return value;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setPending(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  const reset = useCallback(() => {
    setError(null);
    setResult(null);
  }, []);

  return { execute, pending, error, result, clearError, reset };
}

/**
 * A ticking clock for elapsed-time displays.
 *
 * Returns null when not running, so a finished run's elapsed time freezes rather
 * than continuing to count — the audit found the run page passed `undefined` as
 * the end time for every state, so completed runs appeared to still be running.
 */
export function useElapsed(startedAt: string | undefined, endedAt: string | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  const running = Boolean(startedAt) && !endedAt;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : now;
  return Math.max(0, end - start);
}
