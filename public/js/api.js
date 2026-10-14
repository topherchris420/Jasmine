/* Studio API client. The admin key (when the project requires one) lives in this browser's localStorage. */

const KEY = 'jasmine.adminKey';
let authHandler = null;

export function getKey() {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function setKey(value) {
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the key lasts for this page only */
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

async function request(method, path, body, retried = false) {
  const res = await fetch(path, {
    method,
    headers: headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.status === 403 && !retried && authHandler && path.startsWith('/api/')) {
    await authHandler();
    return request(method, path, body, true);
  }
  if (!res.ok) {
    const message = data?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  del: (path) => request('DELETE', path),

  async upload(file) {
    const res = await fetch('/api/files', { method: 'POST', headers: headers({ 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) }), body: file });
    const data = await res.json();
    if (!res.ok) throw new ApiError(data?.errors?.[0]?.message ?? `Upload failed (${res.status})`, res.status, data);
    return data;
  },

  /** POSTs (or GETs) and reads a server-sent-event stream; calls onEvent(event, data). Returns an abort function. */
  stream(path, body, onEvent, onDone) {
    const controller = new AbortController();
    (async () => {
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
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event && data) {
              try {
                onEvent(event, JSON.parse(data));
              } catch (e) {
                console.error(e);
              }
            }
          }
        }
        onDone?.();
      } catch (e) {
        if (e.name !== 'AbortError') onDone?.(e);
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
