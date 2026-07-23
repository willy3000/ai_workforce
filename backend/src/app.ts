import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { router } from './api/routes';
import { errorHandler, notFoundHandler } from './api/middleware/error-handler';
import { httpLogger, requestId } from './api/middleware/request-context';

/**
 * Express application assembly, separated from the server bootstrap so the app
 * can be imported by tests without binding a port or connecting to Mongo.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));
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
