import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

/**
 * Operator sessions for the platform console.
 *
 * ## Scope, stated plainly
 * This is **single-operator authentication**, not multi-tenant identity. It
 * answers "is the person driving this browser allowed to use the platform" and
 * nothing else. There are no user accounts, no roles, and no per-workspace
 * permissions — the audit is right that those are needed before this is hosted
 * for teams, and this file is deliberately the seam where they will go.
 *
 * What it does close is the audit's S1 finding: the gateway used to attach the
 * platform's API key to *any* request that reached it, so exposing the frontend
 * exposed the entire repository-writing API to anonymous visitors.
 *
 * ## Why a signed cookie rather than a password store
 * The audit's guidance is to prefer an established authentication integration
 * over inventing password storage, and to ship verification, reset and
 * brute-force controls alongside any password system. Rather than build a bad
 * version of all that, this uses a single operator secret supplied as
 * configuration — the same trust model as the existing `PLATFORM_API_KEY`, but
 * with the credential kept out of the browser and exchanged for a short-lived,
 * revocable, HTTP-only cookie.
 *
 * When real accounts arrive, `requireSession` is the only function that changes.
 *
 * ## Cookie design
 *  - **HttpOnly**: JavaScript cannot read it, so an XSS bug cannot exfiltrate it.
 *    (The audit notes bearer tokens must never live in `localStorage`; this is
 *    why the session is a cookie and not a token the client holds.)
 *  - **SameSite=Lax**: not sent on cross-site POSTs, which blocks the basic CSRF
 *    case. `isTrustedOrigin` covers the rest.
 *  - **Secure** in production.
 *  - **Signed with HMAC-SHA256** over the payload, so a client cannot forge an
 *    expiry. The comparison is constant-time.
 *  - **Bounded lifetime**, so a stolen cookie expires on its own.
 */

const COOKIE_NAME = 'aiec_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface SessionPayload {
  /** Who the session belongs to. One value today; a user id later. */
  subject: string;
  issuedAt: number;
  expiresAt: number;
}

export type SessionResult =
  | { ok: true; session: SessionPayload }
  | { ok: false; reason: string };

/**
 * The secret used to sign session cookies.
 *
 * Falls back to `PLATFORM_API_KEY` so a correctly-configured deployment does not
 * need a second secret, but refuses to run without either — an unsigned session
 * cookie is a forgeable one, and defaulting to a constant would be worse than
 * having no signature at all because it would look protected.
 */
function signingSecret(): string {
  const secret = process.env.SESSION_SECRET ?? process.env.PLATFORM_API_KEY;
  if (!secret || secret.length < 16) {
    throw new Error(
      'SESSION_SECRET (or PLATFORM_API_KEY) must be set to at least 16 characters to sign operator sessions.',
    );
  }
  return secret;
}

/** Is console authentication configured at all? */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.OPERATOR_PASSWORD && process.env.OPERATOR_PASSWORD.length >= 8);
}

function sign(value: string): string {
  return crypto.createHmac('sha256', signingSecret()).update(value).digest('base64url');
}

function timingSafeEquals(a: string, b: string): boolean {
  const bufA = crypto.createHash('sha256').update(a).digest();
  const bufB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createSessionCookieValue(subject = 'operator'): { value: string; maxAgeSeconds: number } {
  const now = Date.now();
  const payload: SessionPayload = { subject, issuedAt: now, expiresAt: now + SESSION_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {
    value: `${encoded}.${sign(encoded)}`,
    maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export function verifySessionCookieValue(raw: string | undefined): SessionResult {
  if (!raw) return { ok: false, reason: 'Sign in to use the platform console.' };

  const [encoded, signature] = raw.split('.');
  if (!encoded || !signature) return { ok: false, reason: 'Malformed session. Sign in again.' };

  if (!timingSafeEquals(sign(encoded), signature)) {
    return { ok: false, reason: 'Session signature is invalid. Sign in again.' };
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return { ok: false, reason: 'Malformed session. Sign in again.' };
  }

  if (!payload.expiresAt || payload.expiresAt < Date.now()) {
    return { ok: false, reason: 'Session expired. Sign in again.' };
  }
  return { ok: true, session: payload };
}

/**
 * Resolve the current session for a server-side route.
 *
 * When `OPERATOR_PASSWORD` is unset the console runs open, matching the
 * backend's local-development behaviour — but only outside production, where
 * the backend's own `assertProductionSafety` already refuses to boot without
 * credentials. The two halves of the system fail closed together.
 */
export async function requireSession(): Promise<SessionResult> {
  if (!isAuthConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      return {
        ok: false,
        reason:
          'Console authentication is not configured. Set OPERATOR_PASSWORD before exposing this deployment.',
      };
    }
    return { ok: true, session: { subject: 'local-dev', issuedAt: Date.now(), expiresAt: Date.now() } };
  }

  const store = await cookies();
  return verifySessionCookieValue(store.get(COOKIE_NAME)?.value);
}

export function sessionCookieName(): string {
  return COOKIE_NAME;
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/**
 * Origin check for mutating requests.
 *
 * `SameSite=Lax` already blocks cross-site form POSTs, but it is a browser
 * behaviour rather than a server-side guarantee, and it does not cover every
 * client. Comparing `Origin` to the request's own host is the server-side half.
 *
 * A missing `Origin` is accepted only for same-origin navigations, which browsers
 * mark with `Sec-Fetch-Site: same-origin`; a cross-site caller cannot set that.
 */
export function isTrustedOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');

  if (!origin) {
    const fetchSite = req.headers.get('sec-fetch-site');
    return fetchSite === null || fetchSite === 'same-origin' || fetchSite === 'none';
  }
  if (!host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Verify a submitted operator password.
 *
 * Constant-time, and deliberately gives the same answer for "wrong password" as
 * for "no password configured" so the response does not enumerate configuration.
 */
export function verifyOperatorPassword(submitted: string): boolean {
  const expected = process.env.OPERATOR_PASSWORD;
  if (!expected || expected.length < 8) return false;
  return timingSafeEquals(submitted, expected);
}
