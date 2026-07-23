import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { env } from '../../config/env';
import { UnauthorizedError } from '../../utils/errors';

/**
 * Optional shared-secret gate.
 *
 * This platform can write to repositories and open pull requests, so it must not
 * be exposed unauthenticated. When `PLATFORM_API_KEY` is set every `/api` route
 * requires it. Comparison is constant-time to avoid leaking the key by timing.
 *
 * This is intentionally the minimum viable control — a SaaS deployment replaces
 * it with real tenant auth at the same seam.
 */
export const apiKeyAuth: RequestHandler = (req, _res, next) => {
  if (!env.PLATFORM_API_KEY) return next(); // disabled when unset (local dev)

  const provided = req.header('x-api-key') ?? '';
  const expected = env.PLATFORM_API_KEY;

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  const valid =
    providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!valid) return next(new UnauthorizedError('Invalid or missing x-api-key header'));
  return next();
};
