import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { env, isProduction } from '../../config/env';
import { UnauthorizedError } from '../../utils/errors';
import { logger } from '../../utils/logger';

/**
 * Shared-secret gate for the platform API.
 *
 * This platform can write to repositories and open pull requests, so it must not
 * be reachable unauthenticated. Comparison is constant-time to avoid leaking the
 * key by timing.
 *
 * ## Fail-closed (audit finding S1)
 * The previous behaviour was `if (!PLATFORM_API_KEY) return next()` — an unset
 * key silently disabled authentication *including in production*. A missing
 * control must never read as a granted one. Now:
 *
 *  - production without a key does not reach this middleware at all: `env.ts`
 *    refuses to boot (`assertProductionSafety`);
 *  - a non-production process without a key is allowed, because requiring a
 *    secret to run tests is how people end up committing one — but it logs a
 *    warning on every start, and the readiness endpoint reports it so the state
 *    is visible rather than assumed.
 *
 * This is a shared operator credential, not tenant authentication. It answers
 * "may this caller use the platform", not "which workspace's data is this". The
 * seam for real tenancy is `req.actor` below: every controller reads the actor
 * from there rather than from a client-supplied `startedBy` string, so adding
 * verified identities is a change to this file and the repository query
 * contracts, not to every call site.
 */

export interface Actor {
  /** Stable identifier recorded in audit trails. */
  id: string;
  /** How the caller authenticated. */
  kind: 'operator' | 'anonymous';
  /** Display label; never trusted for authorization. */
  label: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

const ANONYMOUS_ACTOR: Actor = {
  id: 'anonymous',
  kind: 'anonymous',
  label: 'unauthenticated local operator',
};

const OPERATOR_ACTOR: Actor = {
  id: 'operator',
  kind: 'operator',
  label: 'platform operator',
};

let warnedAboutOpenApi = false;

export const apiKeyAuth: RequestHandler = (req, _res, next) => {
  if (!env.PLATFORM_API_KEY) {
    // Unreachable in production — env validation exits first — but asserted here
    // too, so a future refactor of env.ts cannot quietly reopen the API.
    if (isProduction) {
      return next(new UnauthorizedError('Platform authentication is not configured'));
    }
    if (!warnedAboutOpenApi) {
      warnedAboutOpenApi = true;
      logger.warn(
        'PLATFORM_API_KEY is unset: the API is accepting unauthenticated requests. ' +
          'This is permitted for local development only.',
      );
    }
    req.actor = ANONYMOUS_ACTOR;
    return next();
  }

  const provided = req.header('x-api-key') ?? '';
  if (!timingSafeEquals(provided, env.PLATFORM_API_KEY)) {
    return next(new UnauthorizedError('Invalid or missing x-api-key header'));
  }

  req.actor = OPERATOR_ACTOR;
  return next();
};

/**
 * Authenticate if credentials are present, but never reject.
 *
 * For endpoints that must answer an unauthenticated probe while still giving
 * operators more detail — readiness is the only one today. The handler branches
 * on `req.actor` being set; it must never treat "no actor" as permission.
 */
export const optionalApiKeyAuth: RequestHandler = (req, _res, next) => {
  const provided = req.header('x-api-key');
  if (env.PLATFORM_API_KEY && provided && timingSafeEquals(provided, env.PLATFORM_API_KEY)) {
    req.actor = OPERATOR_ACTOR;
  } else if (!env.PLATFORM_API_KEY && !isProduction) {
    // Local development with no key configured: the whole API is already open,
    // so withholding diagnostics here would protect nothing.
    req.actor = ANONYMOUS_ACTOR;
  }
  return next();
};

/**
 * Constant-time string comparison that does not leak length.
 *
 * `crypto.timingSafeEqual` throws on a length mismatch, so comparing raw buffers
 * requires a length check first — which is itself a timing signal. Hashing both
 * sides to a fixed width removes it.
 */
export function timingSafeEquals(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Resolve the actor to record for an audited action.
 *
 * Client-supplied `startedBy`/`approvedBy` strings are labels, not identities
 * (audit finding S8). They are preserved as an operator-entered note, but the
 * authoritative actor always comes from the authenticated request.
 */
export function auditActor(req: { actor?: Actor }, claimedLabel?: string): string {
  const actor = req.actor ?? ANONYMOUS_ACTOR;
  const label = claimedLabel?.trim().slice(0, 120);
  return label ? `${actor.id} (${label})` : actor.id;
}
