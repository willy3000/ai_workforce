import { NextRequest, NextResponse } from 'next/server';
import {
  createSessionCookieValue,
  isAuthConfigured,
  isTrustedOrigin,
  sessionCookieName,
  sessionCookieOptions,
  verifyOperatorPassword,
} from '@/lib/session';

/**
 * Exchange the operator password for a session cookie.
 *
 * The password is submitted once and never stored client-side; what the browser
 * keeps is a signed, HTTP-only, expiring cookie that JavaScript cannot read.
 *
 * ## Brute-force control
 * A fixed delay on failure, plus a per-address attempt counter. This is modest
 * on purpose: with a single high-entropy operator secret, online guessing is not
 * the realistic threat, and an aggressive lockout on a single-operator console
 * is a self-inflicted denial of service. If real user accounts arrive, this
 * needs the full treatment the audit describes — and an established auth
 * integration rather than this file.
 */

const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function tooManyAttempts(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isTrustedOrigin(req)) {
    return NextResponse.json(
      { error: { code: 'bad_origin', message: 'Request origin is not trusted.' } },
      { status: 403 },
    );
  }

  if (!isAuthConfigured()) {
    return NextResponse.json(
      {
        error: {
          code: 'auth_not_configured',
          message:
            'Console authentication is not configured on this deployment. ' +
            'Set OPERATOR_PASSWORD (at least 8 characters) in the frontend environment.',
        },
      },
      { status: 503 },
    );
  }

  const clientKey = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (tooManyAttempts(clientKey)) {
    return NextResponse.json(
      {
        error: {
          code: 'rate_limited',
          message: 'Too many sign-in attempts. Wait a few minutes and try again.',
        },
      },
      { status: 429 },
    );
  }

  let password = '';
  try {
    password = ((await req.json()) as { password?: string }).password ?? '';
  } catch {
    password = '';
  }

  if (!verifyOperatorPassword(password)) {
    // A constant delay rather than a variable one: the point is to slow guessing,
    // not to leak how far the comparison got.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return NextResponse.json(
      { error: { code: 'invalid_credentials', message: 'That password is not correct.' } },
      { status: 401 },
    );
  }

  attempts.delete(clientKey);

  const { value, maxAgeSeconds } = createSessionCookieValue();
  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookieName(), value, sessionCookieOptions(maxAgeSeconds));
  return response;
}

/** Sign out by expiring the cookie server-side. */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  if (!isTrustedOrigin(req)) {
    return NextResponse.json(
      { error: { code: 'bad_origin', message: 'Request origin is not trusted.' } },
      { status: 403 },
    );
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookieName(), '', sessionCookieOptions(0));
  return response;
}
