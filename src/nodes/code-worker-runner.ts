import { Worker } from 'node:worker_threads';

/** Deadline isolation for trusted educational code, not a security sandbox.
 * Untrusted/multi-tenant execution still requires an OS/container boundary.
 */
export function runCodeInWorker(code: string, filename: string, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('Code timeout must be a positive integer'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./code-worker.mjs', import.meta.url), {
      workerData: { code, filename },
      // The worker is native JavaScript and must not inherit test/TypeScript loaders.
      execArgv: [],
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let finished = false;
    const finish = (ok: boolean, value: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      // Stop pending microtasks even on success, and settle only once work stops.
      void worker.terminate().then(
        () => { if (ok) resolve(value); else reject(value); },
        (error: unknown) => reject(error),
      );
    };
    const onAbort = () => finish(false, signal.reason);
    const timer = setTimeout(() => finish(false, new Error(`Code execution timed out after ${timeoutMs}ms`)), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (message: { ok: boolean; output?: unknown; error?: string }) => {
      finish(message.ok, message.ok ? message.output : new Error(message.error ?? 'Code execution failed'));
    });
    worker.once('error', (error) => finish(false, error));
    worker.once('exit', (status) => finish(false, new Error(`Code worker exited without a result (status ${status})`)));
    if (signal.aborted) onAbort();
  });
}
