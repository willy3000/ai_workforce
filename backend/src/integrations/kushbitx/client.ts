import { z } from 'zod';
import {
  ChallengeInput, ChallengeTerms, ORIGIN, PreviewInput, PreviewResult, SpendInput, SpendResult,
} from './schemas';

export type PilotErrorCode = 'VALIDATION' | 'UPSTREAM_HTTP' | 'MALFORMED_RESPONSE'
  | 'UNEXPECTED_STATUS' | 'NETWORK' | 'CANCELLED' | 'TIMEOUT' | 'BOUNDARY';

export class PilotError extends Error {
  constructor(readonly code: PilotErrorCode, message: string, readonly status?: number) {
    super(message);
  }
}

interface SdkClient {
  previewToken(address: string): Promise<unknown>;
  evaluateSpend(input: z.infer<typeof SpendInput>): Promise<unknown>;
  getPaymentChallenge(service: 'token-risk', input: { chain: 'base'; address: string }): Promise<unknown>;
}
function parse<T>(schema: z.ZodType<T>, value: unknown, input = false): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PilotError(input ? 'VALIDATION' : 'MALFORMED_RESPONSE',
      input ? 'Invalid KushBitx pilot arguments.' : 'Invalid KushBitx response.');
  }
  return result.data;
}

/** The entire capability passed to tools. No SDK client escapes this module. */
export interface KushBitxPilot {
  previewToken(input: unknown, signal?: AbortSignal): Promise<z.infer<typeof PreviewResult>>;
  evaluateSpend(input: unknown, signal?: AbortSignal): Promise<z.infer<typeof SpendResult>>;
  getPaymentChallenge(input: unknown, signal?: AbortSignal): Promise<{
    service: 'token-risk'; http_status: 402; payment_required: true;
    execution_performed: false; payment_signed: false;
    challenge: z.infer<typeof ChallengeTerms>;
  }>;
}

/** Fetch injection is for trusted application wiring/tests, never model input. */
export function createKushBitxPilot(fetchFn: typeof fetch = globalThis.fetch): KushBitxPilot {
  async function call<T>(path: string, body: unknown, signal: AbortSignal | undefined,
    invoke: (sdk: SdkClient) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    let timedOut = false;
    let called = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const expectedStatus = path === '/api/token-risk' ? 402 : 200;

    // Exactly one request to one approved endpoint per invocation. Reconstruct
    // unsigned headers and body; reject redirects, credentials and SDK retries.
    const restrictedFetch: typeof fetch = async (url, init) => {
      controller.signal.throwIfAborted();
      const headers = new Headers(init?.headers);
      if (called || url !== ORIGIN + path || init?.method !== 'POST'
        || init.body !== JSON.stringify(body)
        || [...headers.keys()].some((key) => key !== 'content-type')
        || headers.get('content-type') !== 'application/json') {
        throw new PilotError('BOUNDARY', 'Request outside the unsigned pilot boundary.');
      }
      called = true;
      const response = await fetchFn(ORIGIN + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
        redirect: 'manual', credentials: 'omit',
      });
      if (response.status !== expectedStatus) {
        await response.body?.cancel();
        const code = response.status >= 400 ? 'UPSTREAM_HTTP' : 'UNEXPECTED_STATUS';
        throw new PilotError(code, `Expected HTTP ${expectedStatus}; received HTTP ${response.status}.`, response.status);
      }
      // Bound response size before SDK JSON parsing. SDK otherwise hides parse
      // failures as {} and discards the original status on HTTP errors.
      const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 64 * 1024) {
            await reader.cancel();
            throw new PilotError('MALFORMED_RESPONSE', 'KushBitx response exceeds size limit.');
          }
          chunks.push(chunk.value);
        }
      }
      controller.signal.throwIfAborted();
      const bytes = Buffer.concat(chunks);
      try {
        JSON.parse(bytes.toString('utf8')) as unknown;
      } catch {
        throw new PilotError('MALFORMED_RESPONSE', 'KushBitx returned invalid JSON.');
      }
      return new Response(bytes, { status: response.status, headers: response.headers });
    };

    try {
      controller.signal.throwIfAborted();
      const { KushBitxClient } = await import('@kushbitx/sdk');
      return await invoke(new KushBitxClient({ baseUrl: ORIGIN, fetchFn: restrictedFetch }));
    } catch (error) {
      if (signal?.aborted) throw new PilotError('CANCELLED', 'KushBitx request cancelled.');
      if (timedOut) throw new PilotError('TIMEOUT', 'KushBitx request timed out.');
      if (error instanceof PilotError) throw error;
      // Never echo upstream messages, bodies or credential-bearing exceptions.
      throw new PilotError('NETWORK', 'KushBitx request failed.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  return Object.freeze({
    async previewToken(input: unknown, signal?: AbortSignal) {
      const { address } = parse(PreviewInput, input, true);
      const raw = await call('/api/token-preview', { chain: 'base', address }, signal,
        (sdk) => sdk.previewToken(address));
      const result = parse(PreviewResult, raw);
      if (result.token.address.toLowerCase() !== address.toLowerCase()) {
        throw new PilotError('MALFORMED_RESPONSE', 'Token address does not match the request.');
      }
      return result;
    },
    async evaluateSpend(input: unknown, signal?: AbortSignal) {
      const body = parse(SpendInput, input, true);
      const raw = await call('/api/spendguard/evaluate', body, signal, (sdk) => sdk.evaluateSpend(body));
      const result = parse(SpendResult, raw);
      if (result.requestId !== body.requestId) {
        throw new PilotError('MALFORMED_RESPONSE', 'Spend decision does not match the request.');
      }
      return result;
    },
    async getPaymentChallenge(input: unknown, signal?: AbortSignal) {
      const { address } = parse(ChallengeInput, input, true);
      const body = { chain: 'base' as const, address };
      const raw = await call('/api/token-risk', body, signal,
        (sdk) => sdk.getPaymentChallenge('token-risk', body));
      const envelope = parse(z.object({
        service: z.literal('token-risk'), path: z.literal('/api/token-risk'),
        challenge: z.object({}),
        paymentRequired: z.string().min(1).max(16_384).regex(/^[A-Za-z0-9+/]+={0,2}$/),
      }), raw);
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(envelope.paymentRequired, 'base64').toString('utf8')) as unknown;
      } catch {
        throw new PilotError('MALFORMED_RESPONSE', 'Invalid x402 challenge header.');
      }
      const challenge = parse(ChallengeTerms, decoded);
      // The header is the authoritative x402 contract. Do not return arbitrary
      // response body, extensions, opaque headers or any paid completion path.
      return { service: 'token-risk' as const, http_status: 402 as const,
        payment_required: true as const, execution_performed: false as const,
        payment_signed: false as const, challenge };
    },
  });
}
