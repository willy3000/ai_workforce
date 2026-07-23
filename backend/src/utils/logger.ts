import pino from 'pino';
import { env, isProduction } from '../config/env';

/**
 * Structured logging. In development we pretty-print; in production we emit
 * newline-delimited JSON so a log shipper can index agent/task/tool fields.
 *
 * Convention: every log line emitted from inside an agent run carries
 * `{ projectId, taskId, agent }` so a whole multi-agent workflow can be
 * reconstructed from logs alone.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'ai-engineering-company' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'token',
      'accessToken',
      'apiKey',
      '*.token',
      '*.apiKey',
    ],
    censor: '[redacted]',
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
});

export type Logger = pino.Logger;
