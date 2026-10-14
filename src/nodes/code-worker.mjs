import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

// A separate worker allows the parent to terminate synchronous and asynchronous
// loops. vm and workers are not a security boundary for hostile code.
const context = vm.createContext(undefined, { codeGeneration: { strings: false, wasm: false } });
// Define globals inside the realm: never inject host functions or host objects.
new vm.Script('globalThis.output = undefined; globalThis.console = { log() {}, warn() {}, error() {} };').runInContext(context);

try {
  const returned = await new vm.Script(`(async () => {\n${workerData.code}\n})()`, { filename: workerData.filename }).runInContext(context);
  // Studio-style assignment takes precedence over a plain return.
  const output = context.output !== undefined ? context.output : returned;
  parentPort.postMessage({ ok: true, output });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message ?? String(error) });
}
