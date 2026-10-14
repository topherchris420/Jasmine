import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';

export const TEMPLATE_IN_CODE = /\{\{\s*([^{}]+?)\s*\}\}/g;

const parsesAsJs = (code: string) => {
  try {
    new vm.Script(`(async () => {\n${code.replace(TEMPLATE_IN_CODE, 'null')}\n})`);
    return true;
  } catch {
    return false;
  }
};

/**
 * Code from Lamatic Studio and AgentKit is often TypeScript (`declare let output: any;`, interfaces,
 * annotations). When the code is not valid JavaScript, erase its types with Node's built-in stripper,
 * keeping {{references}} intact. Code that is still invalid is returned unchanged so the syntax error
 * reported is the author's own.
 */
export function eraseTypes(code: string): string {
  if (parsesAsJs(code)) return code;
  const prefix = 'async function __jasmine_code__() {\n';
  const suffix = '\n}';
  const refs: string[] = [];
  const masked = code
    .replace(/^\s*declare\s+(?:let|const|var|function|class)\b[^\n]*$/gm, (m) => ' '.repeat(m.length))
    .replace(TEMPLATE_IN_CODE, (m) => `__jasmine_ref_${refs.push(m) - 1}__`);
  try {
    const js = stripTypeScriptTypes(prefix + masked + suffix, { mode: 'strip' });
    const out = js.slice(prefix.length, js.length - suffix.length).replace(/__jasmine_ref_(\d+)__/g, (_, i: string) => refs[Number(i)]!);
    return parsesAsJs(out) ? out : code;
  } catch {
    return code;
  }
}

/**
 * Runs Code-node JavaScript in a worker with a deadline and memory limits. This isolates mistakes made by
 * flow authors; it is not a security sandbox. Untrusted or multi-tenant code needs an OS or container boundary.
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
