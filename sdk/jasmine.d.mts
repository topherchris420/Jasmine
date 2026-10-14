export interface RunError { code: string; message: string; nodeId?: string; retryable?: boolean }
export interface RunResponse {
  status: 'success' | 'failed' | 'error' | 'in-progress';
  requestId: string;
  result?: unknown;
  output?: unknown;
  input?: unknown;
  version?: string;
  cached?: boolean;
  statusCode?: number;
  timeTakenInSeconds?: number;
  usage?: { llmCalls?: number; inputTokens?: number; outputTokens?: number };
  models?: string[];
  nodes?: { nodeId: string; nodeType?: string; nodeName?: string; status: string; statusCode?: number; durationMs?: number; error?: RunError }[];
  error?: RunError;
  /** The error message of a failed run (same as error.message). */
  message?: string;
}
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const DEFAULT_EXECUTE_TIMEOUT_MS: number;
export class JasmineError extends Error {
  constructor(message: string, status: number, body?: unknown, code?: string);
  /** HTTP status; 0 when no response arrived (for example a TIMEOUT). */
  status: number;
  /** Parsed JSON error body, or the raw text when the server (or a proxy in front of it) did not answer with JSON. */
  body: unknown;
  /** Server error code (e.g. NOT_FOUND, FORBIDDEN), or TIMEOUT / INVALID_RESPONSE from the client. */
  code?: string;
}
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }
export class JasmineClient {
  constructor(options?: {
    endpoint?: string;
    apiKey?: string;
    projectId?: string;
    fetch?: typeof fetch;
    /** Budget for one ordinary request in ms (default 60 000; 0 or Infinity disables it). */
    timeoutMs?: number;
    /** Budget for a realtime executeFlow call in ms (default 150 000). */
    executeTimeoutMs?: number;
  });
  endpoint: string;
  apiKey?: string;
  projectId?: string;
  timeoutMs: number;
  executeTimeoutMs: number;
  headers(extra?: Record<string, string>): Record<string, string>;
  request(path: string, options?: RequestOptions & { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<any>;
  executeFlow(flowId: string, payload?: unknown, options?: RequestOptions & { mode?: 'realtime' | 'async'; idempotencyKey?: string; version?: string; bypassCache?: boolean }): Promise<RunResponse>;
  checkStatus(requestId: string, options?: RequestOptions): Promise<RunResponse>;
  cancel(requestId: string, options?: RequestOptions): Promise<{ cancelled: boolean }>;
  retry(requestId: string, options?: RequestOptions): Promise<RunResponse>;
  trace(requestId: string, options?: RequestOptions): Promise<{ trace: unknown[] }>;
  /** `timeoutMs` bounds the whole wait (default 120 000). */
  wait(requestId: string, options?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<RunResponse>;
  /** Server-sent run events (trace, node.token, node.progress, done). No request timeout applies. */
  events(requestId: string, options?: { signal?: AbortSignal }): AsyncGenerator<{ event: string; data: any }>;
}
