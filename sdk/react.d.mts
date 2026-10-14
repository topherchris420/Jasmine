import type { ReactElement } from 'react';
import type { RunResponse } from './jasmine.mjs';

export interface FlowOptions {
  endpoint: string;
  flowId: string;
  apiKey?: string;
  projectId?: string;
}
export function useJasmineFlow(options: FlowOptions): {
  status: RunResponse['status'] | 'idle';
  output: unknown;
  error: {message: string; code?: string} | null;
  tokens: string;
  requestId: string | null;
  execute(payload: unknown, options?: {idempotencyKey?: string; version?: string; bypassCache?: boolean; timeoutMs?: number}): Promise<RunResponse>;
  cancel(): Promise<void>;
};
export function JasmineChat(props: {
  endpoint?: string;
  flowId: string;
  className?: string;
  onError?: (error: Error) => void;
}): ReactElement;
