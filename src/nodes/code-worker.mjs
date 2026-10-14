import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

// A separate worker allows the parent to terminate synchronous and asynchronous
// loops. vm and workers are not a security boundary for hostile code.
const context = vm.createContext(undefined, { codeGeneration: { strings: false, wasm: false } });

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

// Host helpers exchange only strings with the code realm; the realm wraps them in its own objects.
const hostTimer = (ms, callback) => {
  setTimeout(() => {
    try {
      callback();
    } catch {
      /* errors in timer callbacks are the code's own */
    }
  }, Math.min(Math.max(Number(ms) || 0, 0), 600_000));
};
const hostFetch = (requestJson, callback) => {
  (async () => {
    try {
      const req = JSON.parse(requestJson);
      const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: 'follow' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_RESPONSE_BYTES) throw new Error('response is larger than 10 MB');
      callback(null, JSON.stringify({ status: res.status, statusText: res.statusText, url: res.url, headers: [...res.headers], body: buf.toString('utf8') }));
    } catch (error) {
      callback(String(error?.cause?.message ?? error?.message ?? error), null);
    }
  })();
};
context.__timer = hostTimer;
context.__fetch = hostFetch;
// Resolved {{template}} values enter the realm as JSON data (never spliced into the code text).
context.__valuesJson = JSON.stringify(workerData.values ?? []);

// Define globals inside the realm and hide the host helpers in a closure.
new vm.Script(`(() => {
  'use strict';
  const timer = globalThis.__timer;
  const net = globalThis.__fetch;
  delete globalThis.__timer;
  delete globalThis.__fetch;
  globalThis.__jasmine_values = JSON.parse(globalThis.__valuesJson || '[]');
  delete globalThis.__valuesJson;
  globalThis.output = undefined;
  globalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  let nextId = 0;
  const cancelled = new Set();
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = ++nextId;
    timer(ms, () => { if (!cancelled.has(id) && typeof fn === 'function') fn(...args); });
    return id;
  };
  globalThis.clearTimeout = (id) => { cancelled.add(id); };
  globalThis.fetch = (input, init = {}) => new Promise((resolve, reject) => {
    const url = String(input && typeof input === 'object' && 'url' in input ? input.url : input);
    const headers = {};
    const given = init.headers || {};
    for (const [k, v] of Array.isArray(given) ? given : Object.entries(given)) headers[String(k)] = String(v);
    const body = init.body === undefined || init.body === null ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    net(JSON.stringify({ url, method: String(init.method || 'GET').toUpperCase(), headers, body }), (error, text) => {
      if (error) { reject(new TypeError('fetch failed: ' + error)); return; }
      const r = JSON.parse(text);
      const map = new Map(r.headers.map(([k, v]) => [k.toLowerCase(), v]));
      resolve({
        ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusText, url: r.url,
        headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null, has: (k) => map.has(String(k).toLowerCase()), entries: () => map.entries() },
        text: async () => r.body,
        json: async () => JSON.parse(r.body),
      });
    });
  });
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  globalThis.btoa = (input) => {
    const s = String(input);
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new Error('btoa: character out of range');
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return out;
  };
  globalThis.atob = (input) => {
    const s = String(input).replace(/[\\s=]+/g, '');
    let out = '';
    let bits = 0, value = 0;
    for (const ch of s) {
      const v = B64.indexOf(ch);
      if (v < 0) throw new Error('atob: invalid base64');
      value = (value << 6) | v;
      bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((value >> bits) & 255); }
    }
    return out;
  };
})();`).runInContext(context);

try {
  const returned = await new vm.Script(`(async () => {\n${workerData.code}\n})()`, { filename: workerData.filename }).runInContext(context);
  // Studio-style assignment takes precedence over a plain return.
  const output = context.output !== undefined ? context.output : returned;
  parentPort.postMessage({ ok: true, output });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message ?? String(error) });
}
