export interface RunResponse { status: 'success' | 'failed' | 'error' | 'in-progress'; requestId: string; result?: unknown; output?: unknown; version?: string; error?: { code: string; message: string }; }
export class JasmineError extends Error { status: number; body: unknown; code?: string; }
export class JasmineClient {
  constructor(options?: { endpoint?: string; apiKey?: string; projectId?: string; fetch?: typeof fetch });
  request(path: string, options?: { method?: string; body?: unknown; headers?: Record<string,string>; signal?: AbortSignal }): Promise<any>;
  executeFlow(flowId: string, payload?: unknown, options?: { mode?: 'realtime' | 'async'; idempotencyKey?: string; version?: string; signal?: AbortSignal }): Promise<RunResponse>;
  checkStatus(requestId: string, options?: { signal?: AbortSignal }): Promise<RunResponse>;
  cancel(requestId: string): Promise<{ cancelled: boolean }>;
  retry(requestId: string): Promise<RunResponse>;
  trace(requestId: string): Promise<{ trace: unknown[] }>;
  wait(requestId: string, options?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<RunResponse>;
  events(requestId: string, options?: { signal?: AbortSignal }): AsyncGenerator<{ event: string; data: any }>;
}
