import { NextRequest, NextResponse } from 'next/server';

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
 */
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4000';

// Agent runs are long — a feature-development workflow executes several models.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

async function forward(req: NextRequest, path: string[]): Promise<NextResponse> {
  const search = req.nextUrl.search ?? '';
  const target = `${BACKEND_URL}/api/${path.join('/')}${search}`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.PLATFORM_API_KEY) headers['x-api-key'] = process.env.PLATFORM_API_KEY;

  let body: string | undefined;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    body = await req.text();
  }

  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
      body,
      cache: 'no-store',
    });

    const text = await res.text();
    // Pass the backend's status through untouched so the UI can distinguish
    // a 409 "approval required" from a 502 provider error.
    return new NextResponse(text || '{}', {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          code: 'backend_unreachable',
          message:
            `Cannot reach the platform backend at ${BACKEND_URL}. ` +
            'Start it with `npm run dev` in ./backend, or set BACKEND_URL.',
          detail: (err as Error).message,
        },
      },
      { status: 503 },
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
