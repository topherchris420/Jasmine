/* Studio uses an HttpOnly session cookie. A temporary key supports legacy callers in this tab. */

const KEY = 'jasmine.adminKey';
let authHandler = null;
let transientKey = '';

export function getKey() {
  return transientKey;
}

export function setKey(value) {
  transientKey = value || '';
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* optional legacy cleanup */
  }
}

/** Called when the server answers 403; should resolve once the user has supplied a key (or reject). */
export function onAuthRequired(fn) {
  authHandler = fn;
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = body?.errors?.[0]?.extensions?.code;
    this.diagnostics = body?.errors?.[0]?.extensions?.diagnostics;
  }
}

const headers = (extra = {}) => {
  const key = getKey();
  return { ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra };
};

/* Connectivity: Studio reports when the runtime stops answering and when it is back. */
let online = true;
function setOnline(next) {
  if (online === next) return;
  online = next;
  try { window.dispatchEvent(new CustomEvent('jasmine:connectivity', { detail: { online } })); } catch { /* no window in tests */ }
}
export const isOnline = () => online;

const OFFLINE_MESSAGE = 'Jasmine can’t reach its runtime right now. Check your connection; Studio retries automatically.';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method, path, body, retried = false, opts = {}) {
  let res;
  // Reads are safe to repeat after a dropped connection; writes are never retried automatically.
  const attempts = method === 'GET' ? 3 : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(path, {
        method,
        headers: headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000) } : {}),
      });
      break;
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new ApiError('The runtime took too long to answer. The work may still be running; check Runs before retrying.', 0, { errors: [{ extensions: { code: 'TIMEOUT' } }] });
      if (attempt >= attempts) {
        setOnline(false);
        throw new ApiError(OFFLINE_MESSAGE, 0, { errors: [{ extensions: { code: 'NETWORK' } }] });
      }
      await wait(300 * 3 ** (attempt - 1));
    }
  }
  setOnline(res.status !== 502 && res.status !== 503 && res.status !== 504 ? true : online);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.status === 403 && !retried && authHandler && path.startsWith('/api/') && !path.startsWith('/api/auth/')) {
    await authHandler();
    return request(method, path, body, true, opts);
  }
  if (!res.ok) {
    const message = data?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, false, opts),
  post: (path, body = {}, opts) => request('POST', path, body, false, opts),
  put: (path, body = {}, opts) => request('PUT', path, body, false, opts),
  del: (path, opts) => request('DELETE', path, undefined, false, opts),

  async upload(file) {
    let res;
    try {
      res = await fetch('/api/files', { method: 'POST', headers: headers({ 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) }), body: file });
    } catch {
      setOnline(false);
      throw new ApiError(`${file.name} was not uploaded. ${OFFLINE_MESSAGE}`, 0, null);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(data?.errors?.[0]?.message ?? (res.status === 413 ? `${file.name} is too large to upload here.` : `Upload failed (${res.status})`), res.status, data);
    return data;
  },

  /** POSTs (or GETs) and reads a server-sent-event stream; calls onEvent(event, data). Returns an abort function. */
  stream(path, body, onEvent, onDone) {
    const controller = new AbortController();
    (async () => {
      const resumable = body === undefined && /^\/api\/runs\/[^/]+\/events$/.test(path);
      let finished = false, failures = 0;
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(path, {
            method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
            headers: headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
          if (!res.ok || !res.body) {
            const data = await res.json().catch(() => null);
            throw new ApiError(data?.errors?.[0]?.message ?? `HTTP ${res.status}`, res.status, data);
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              failures = 0;
              buffer += decoder.decode(value, { stream: true });
              let split;
              while ((split = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, split); buffer = buffer.slice(split + 2);
                const event = /^event: (.*)$/m.exec(block)?.[1];
                const data = /^data: (.*)$/m.exec(block)?.[1];
                if (event && data) {
                  if (event === 'done') finished = true;
                  try { onEvent(event, JSON.parse(data)); } catch (error) { console.error(error); }
                }
              }
            }
          } finally { reader.releaseLock(); }
          if (!resumable || finished) { onDone?.(); return; }
          // A gateway may end a healthy stream before the job finishes. Re-subscribe;
          // the runtime returns a final result if the job completed in the gap.
        } catch (error) {
          if (controller.signal.aborted) return;
          if (!resumable || finished || error.status === 403 || ++failures >= 3) { onDone?.(error); return; }
        }
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, Math.min(4000, 300 * 2 ** failures));
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    })();
    return () => controller.abort();
  },
};

/** Catalog and lookups shared across pages, loaded once per session. */
let catalogPromise = null;
export function catalog() {
  catalogPromise ??= api.get('/api/catalog').then((list) => {
    const byType = new Map(list.map((n) => [n.type, n]));
    return { list, byType };
  }).catch((e) => {
    catalogPromise = null;
    throw e;
  });
  return catalogPromise;
}
