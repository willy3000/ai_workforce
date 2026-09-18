import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

/**
 * Server-side proxy to the platform backend.
 *
 * Every browser request goes through here rather than calling the backend
 * directly. Two reasons, both deliberate:
 *
 *  1. **The platform API key never reaches the browser.** This key authorises
 *     an API that can write to repositories and open pull requests — shipping it
 *     in a client bundle (`NEXT_PUBLIC_...`) would hand that capability to
 *     anyone who opens devtools. It is injected here, server-side.
 *  2. No CORS surface and no mixed-origin cookie problems; the backend can stay
 *     bound to a private network in production.
 *
 * ## The gap this used to leave open (audit finding S1)
 * Reason 1 protects the *key*. It does nothing to protect the *capability*: this
 * route was unauthenticated, so anyone who could load the page could drive the
 * whole API through it. Hiding the key while forwarding every request is
 * security theatre — the attacker never needed the key, they needed this URL.
 *
 * The route now requires an operator session before it will attach the key, and
 * checks the request's origin on every mutating call. Sessions are issued by
 * `/api/auth/login` against `OPERATOR_PASSWORD`; see `lib/session.ts` for why
 * that shape was chosen over inventing password storage.
 */
import { requireSession, isTrustedOrigin } from '@/lib/session';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4000';

/**
 * Runs are no longer executed inside the request (the backend returns a queued
 * run immediately), so this only has to cover ordinary API calls. The previous
 * 300s hint conflicted with provider calls that could last 600s — a conflict
 * that disappears once nothing here waits on a model.
 */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** Statuses that must not carry a body, per the Fetch/HTTP specs. */
const BODYLESS_STATUSES = new Set([204, 205, 304]);

/** Response headers worth passing through; everything else is dropped. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'retry-after', 'ratelimit-limit', 'ratelimit-remaining'];

async function forward(req: NextRequest, path: string[]): Promise<NextResponse> {
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';

  // CSRF: a server-only key gives the browser no protection, because the
  // browser is the thing being tricked. An origin check is what stops another
  // site from driving this API with the operator's own session.
  if (mutating && !isTrustedOrigin(req)) {
    return NextResponse.json(
      { error: { code: 'bad_origin', message: 'Request origin is not trusted.' } },
      { status: 403 },
    );
  }

  const session = await requireSession();
  if (!session.ok) {
    return NextResponse.json(
      {
        error: {
          code: 'unauthenticated',
          message: session.reason,
        },
      },
      { status: 401 },
    );
  }

  const search = req.nextUrl.search ?? '';
  const target = `${BACKEND_URL}/api/${path.join('/')}${search}`;

  // One id ties a browser action to its backend log lines and back to the error
  // the operator was shown — the difference between a support ticket that can be
  // investigated and one that cannot.
  const correlationId = req.headers.get('x-request-id') ?? randomUUID();

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': correlationId,
  };
  if (process.env.PLATFORM_API_KEY) headers['x-api-key'] = process.env.PLATFORM_API_KEY;

  let body: string | undefined;
  if (mutating && req.method !== 'DELETE') {
    body = await req.text();
  }

  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
      body,
      cache: 'no-store',
    });

    const outHeaders = new Headers({ 'x-request-id': correlationId });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = res.headers.get(name);
      if (value) outHeaders.set(name, value);
    }

    // A 204 must not carry a body. The previous `text || '{}'` fallback
    // manufactured one, and the Response constructor rejects that — so a
    // successful DELETE surfaced to the user as a gateway error *after* the
    // deletion had already happened (audit: "gateway mishandles 204").
    if (BODYLESS_STATUSES.has(res.status)) {
      return new NextResponse(null, { status: res.status, headers: outHeaders });
    }

    const text = await res.text();
    if (!outHeaders.has('content-type')) outHeaders.set('content-type', 'application/json');

    // Pass the backend's status through untouched so the UI can distinguish
    // a 409 "approval required" from a 502 provider error.
    return new NextResponse(text || '{}', { status: res.status, headers: outHeaders });
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          code: 'backend_unreachable',
          message:
            `Cannot reach the platform backend at ${BACKEND_URL}. ` +
            'Start it with `npm run dev` in ./backend, or set BACKEND_URL.',
          // The underlying message can contain a host and port, which is fine
          // for an authenticated operator and is the whole value of this error.
          detail: (err as Error).message,
          correlationId,
        },
      },
      { status: 503, headers: { 'x-request-id': correlationId } },
    );
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
