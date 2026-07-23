import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { isProduction } from '../../config/env';

/**
 * Terminal error middleware.
 *
 * Two rules: never leak an internal message or stack to a client in production,
 * and always log the full error server-side with the request id so the redacted
 * client response can still be traced.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = res.getHeader('x-request-id');

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    // Operational errors are expected; log at warn, not error.
    logger.warn(
      { code: err.code, statusCode: err.statusCode, path: req.path, requestId },
      err.message,
    );
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
    return;
  }

  logger.error({ err, path: req.path, method: req.method, requestId }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: isProduction ? 'An internal error occurred' : (err as Error).message,
      requestId,
    },
  });
};

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
  });
};
