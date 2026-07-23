import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not forward rejected promises to the error middleware.
 * Every async controller is wrapped in this so a rejected promise becomes a
 * proper 4xx/5xx instead of an unhandled rejection that kills the process.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
