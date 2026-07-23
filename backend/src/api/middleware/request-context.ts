import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import pinoHttp from 'pino-http';
import { logger } from '../../utils/logger';

/** Assign (or propagate) a request id so a client error can be traced in logs. */
export const requestId: RequestHandler = (req, res, next) => {
  const id = req.header('x-request-id') ?? crypto.randomUUID();
  res.setHeader('x-request-id', id);
  next();
};

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => (res.getHeader('x-request-id') as string) ?? crypto.randomUUID(),
  // Agent runs are long; a 30s request is normal here and should not log as slow.
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  autoLogging: {
    ignore: (req) => req.url === '/api/health' || req.url === '/health',
  },
});
