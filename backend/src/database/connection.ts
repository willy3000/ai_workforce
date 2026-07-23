import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Mongoose connection lifecycle.
 *
 * `strictQuery: true` keeps stray filter keys from silently matching every
 * document — an important guard when filters are built from API input.
 */
mongoose.set('strictQuery', true);

let connecting: Promise<typeof mongoose> | null = null;

export async function connectDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (connecting) return connecting;

  connecting = mongoose
    .connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 20,
      autoIndex: env.NODE_ENV !== 'production',
    })
    .then((m) => {
      logger.info({ db: m.connection.name }, 'MongoDB connected');
      return m;
    })
    .catch((err) => {
      connecting = null;
      throw err;
    });

  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  return connecting;
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  connecting = null;
  logger.info('MongoDB disconnected cleanly');
}

/**
 * In production `autoIndex` is off (index builds block writes on large
 * collections), so indexes are created explicitly at boot instead.
 */
export async function ensureIndexes(): Promise<void> {
  const models = mongoose.modelNames().map((name) => mongoose.model(name));
  await Promise.all(models.map((m) => m.createIndexes()));
  logger.info({ models: models.length }, 'Indexes ensured');
}

export function isDatabaseHealthy(): boolean {
  return mongoose.connection.readyState === 1;
}
