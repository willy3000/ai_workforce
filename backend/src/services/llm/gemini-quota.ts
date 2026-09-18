import { ProviderError } from '../../utils/errors';

interface Reservation {
  startedAt: number;
  tokens: number;
}

export interface GeminiQuotaReservation {
  release(actualTokens?: number): void;
}

/**
 * Process-local rolling-window limiter for one Gemini model quota.
 *
 * Reservations are made before a request starts, so concurrent workflow turns
 * cannot collectively exceed the configured token budget. A deployment with
 * multiple backend replicas needs a shared limiter to enforce one account-wide
 * quota; this protects the local process, which is the current deployment shape.
 */
export class GeminiQuotaLimiter {
  private readonly reservations: Reservation[] = [];

  constructor(
    private readonly requestsPerMinute = 30,
    private readonly tokensPerMinute = 16_000,
    private readonly windowMs = 60_000,
  ) {}

  async reserve(
    estimatedInputTokens: number,
    maxOutputTokens: number,
    signal?: AbortSignal,
  ): Promise<GeminiQuotaReservation> {
    const requestedTokens = estimatedInputTokens + maxOutputTokens;
    if (requestedTokens > this.tokensPerMinute) {
      throw new ProviderError(
        `Gemini request needs approximately ${requestedTokens} tokens, above the ` +
          `${this.tokensPerMinute}-token per-minute quota. Reduce the prompt or output limit.`,
        { code: 'gemini_tpm_exceeded' },
      );
    }

    while (true) {
      this.prune();
      const tokenTotal = this.reservations.reduce((total, item) => total + item.tokens, 0);
      if (
        this.reservations.length < this.requestsPerMinute &&
        tokenTotal + requestedTokens <= this.tokensPerMinute
      ) {
        const reservation: Reservation = { startedAt: Date.now(), tokens: requestedTokens };
        this.reservations.push(reservation);
        return {
          release: (actualTokens = requestedTokens) => {
            reservation.tokens = Math.min(requestedTokens, Math.max(0, actualTokens));
          },
        };
      }

      const waitMs = this.waitTime(requestedTokens, tokenTotal);
      await this.delay(waitMs, signal);
    }
  }

  private prune(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    while (this.reservations[0] && this.reservations[0].startedAt <= cutoff) {
      this.reservations.shift();
    }
  }

  private waitTime(requestedTokens: number, tokenTotal: number): number {
    const now = Date.now();
    const oldest = this.reservations[0];
    if (this.reservations.length >= this.requestsPerMinute && oldest) {
      return Math.max(1, oldest.startedAt + this.windowMs - now);
    }

    let runningTokens = tokenTotal;
    for (const reservation of this.reservations) {
      runningTokens -= reservation.tokens;
      if (runningTokens + requestedTokens <= this.tokensPerMinute) {
        return Math.max(1, reservation.startedAt + this.windowMs - now);
      }
    }
    return Math.max(1, (oldest?.startedAt ?? now) + this.windowMs - now);
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error('Gemini quota wait cancelled'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('Gemini quota wait cancelled'));
        },
        { once: true },
      );
    });
  }
}

export const geminiQuotaLimiter = new GeminiQuotaLimiter();