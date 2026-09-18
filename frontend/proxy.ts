import { NextResponse, type NextRequest } from 'next/server';

/**
 * Redirect unauthenticated navigation to the sign-in page.
 *
 * Next.js 16 renamed this convention from `middleware.ts` to `proxy.ts`; the
 * behaviour and the edge-runtime constraints are unchanged.
 *
 * ## This is convenience, not the control
 * The audit is explicit that you must "protect route handlers and data access,
 * not just page navigation" — middleware that only guards pages is a sign, not a
 * lock, because the API route is still reachable directly.
 *
 * So the actual enforcement lives in the gateway route handler, which calls
 * `requireSession()` before it will attach the platform API key. This middleware
 * exists purely so an operator whose session expired lands on a sign-in form
 * rather than on a workspace where every panel renders "401".
 *
 * It deliberately does *not* verify the signature. Middleware runs on the edge
 * runtime where `node:crypto` is unavailable, and duplicating the verification
 * with a different implementation would create two sources of truth about what a
 * valid session is. Presence is enough for a redirect decision; validity is
 * decided in one place, by the handler that acts on it.
 */

const PUBLIC_PATHS = ['/login'];

export default function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Static assets, Next internals, and the auth endpoint itself.
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/auth') ||
    pathname === '/favicon.ico' ||
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return NextResponse.next();
  }

  // When no operator password is configured the console runs open, matching the
  // backend's local-development posture. The gateway still refuses in
  // production, so the two halves fail closed together.
  if (!process.env.OPERATOR_PASSWORD) return NextResponse.next();

  if (req.cookies.has('aiec_session')) return NextResponse.next();

  // API calls get a 401 to handle, not a redirect to an HTML page — a fetch that
  // receives a login form is a confusing parse error rather than a clear signal.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: { code: 'unauthenticated', message: 'Sign in to use the platform console.' } },
      { status: 401 },
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  // Preserve where they were going, so signing in returns them there.
  url.search = `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
