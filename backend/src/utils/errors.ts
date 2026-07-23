/**
 * Error taxonomy.
 *
 * Two families matter to this platform:
 *  - `AppError`         : an operational failure we expect and can describe.
 *  - `ToolExecutionError`: a failure *inside* an agent tool call. These are NOT
 *    thrown to the caller — the agent runtime catches them and feeds the message
 *    back to the model as `is_error: true` tool results so the agent can adapt
 *    (retry with a different path, ask for clarification, etc.).
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly isOperational = true;

  constructor(message: string, statusCode = 500, code = 'internal_error', details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(id ? `${resource} '${id}' not found` : `${resource} not found`, 404, 'not_found');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'validation_error', details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'conflict', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid credentials') {
    super(message, 401, 'unauthorized');
  }
}

/** An agent attempted an action its permission profile forbids. */
export class PermissionDeniedError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 403, 'permission_denied', details);
  }
}

/** Recoverable failure inside a tool; surfaced back to the model, not the client. */
export class ToolExecutionError extends Error {
  public readonly recoverable: boolean;
  constructor(message: string, recoverable = true) {
    super(message);
    this.name = 'ToolExecutionError';
    this.recoverable = recoverable;
  }
}

/** The LLM provider failed in a way the caller should know about. */
export class ProviderError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 502, 'provider_error', details);
  }
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
