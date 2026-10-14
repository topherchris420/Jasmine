export type ErrorCode =
  | 'INTERRUPTED'
  | 'BAD_PAYLOAD'
  | 'PAYLOAD_TOO_LARGE'
  | 'TIMEOUT'
  | 'DEADLINE_EXCEEDED'
  | 'CANCELLED'
  | 'TEMPLATE_UNRESOLVED'
  | 'UPSTREAM_HTTP'
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'PROVIDER'
  | 'CODE_ERROR'
  | 'OUTPUT_SCHEMA'
  | 'NO_RESPONSE'
  | 'LOOP_LIMIT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'OVERLOADED'
  | 'COMPILE'
  | 'DEPLOY_FAILED'
  | 'FORBIDDEN'
  | 'INTERNAL';

export interface EngineErrorOptions {
  retryable?: boolean;
  nodeId?: string;
  details?: unknown;
  cause?: unknown;
}

export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly nodeId: string | undefined;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, opts: EngineErrorOptions = {}) {
    super(message, { cause: opts.cause });
    this.name = 'EngineError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.nodeId = opts.nodeId;
    this.details = opts.details;
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, nodeId: this.nodeId };
  }
}

export function toEngineError(err: unknown, nodeId?: string): EngineError {
  if (err instanceof EngineError) {
    return err.nodeId || !nodeId ? err : new EngineError(err.code, err.message, { ...err, nodeId, cause: err.cause });
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new EngineError('TIMEOUT', err.message, { retryable: true, nodeId, cause: err });
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new EngineError('CANCELLED', err.message, { nodeId, cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new EngineError('INTERNAL', message, { nodeId, cause: err });
}
