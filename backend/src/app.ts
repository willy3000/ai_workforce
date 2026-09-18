import express, { type Express } from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import { router } from './api/routes';
import { errorHandler, notFoundHandler } from './api/middleware/error-handler';
import { httpLogger, requestId } from './api/middleware/request-context';
import { env } from './config/env';

/**
 * Build the CORS policy from the configured allowlist.
 *
 * Audit finding S10: `cors({ origin: true, credentials: true })` reflects
 * whatever `Origin` the caller sends and marks the response credentialed, which
 * means *any* site could make credentialed cross-origin calls. That is not a
 * policy, it is the absence of one.
 *
 * The intended production topology has no browser talking to this service at
 * all — the Next.js gateway does, server to server, and CORS does not apply.
 * `CORS_ALLOWED_ORIGINS=none` states that explicitly and denies every browser
 * origin, which is both the safest setting and the one that matches the
 * documented deployment.
 */
export function corsOptions(): CorsOptions {
  const configured = env.CORS_ALLOWED_ORIGINS;
  const denyAll = !configured.length || (configured.length === 1 && configured[0] === 'none');

  return {
    credentials: true,
    maxAge: 600,
    origin(origin, callback) {
      // No Origin header: a server-to-server call (the gateway) or a same-origin
      // navigation. CORS has nothing to say about these; the API key does.
      if (!origin) return callback(null, true);
      if (denyAll) return callback(null, false);
      return callback(null, configured.includes(origin.toLowerCase()));
    },
  };
}

/**
 * Express application assembly, separated from the server bootstrap so the app
 * can be imported by tests without binding a port or connecting to Mongo.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors(corsOptions()));
  // Agent-authored payloads (plans, diffs, reports) are large but bounded.
  app.use(express.json({ limit: '5mb' }));
  app.use(requestId);
  app.use(httpLogger);

  app.get('/', (_req, res) => {
    res.json({
      name: 'AI Engineering Company',
      description: 'Multi-agent engineering platform. See GET /api/health/ready for capabilities.',
      api: '/api',
    });
  });

  app.use('/api', router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
