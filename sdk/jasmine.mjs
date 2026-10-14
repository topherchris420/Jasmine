/** Dependency-free Jasmine client for Node.js and browser applications. */
export class JasmineError extends Error {
  constructor(message, status, body, code) {
    super(message);
    this.name = 'JasmineError';
    this.status = status;
    this.body = body;
    this.code = code ?? body?.errors?.[0]?.extensions?.code;
  }
}

/** Default budget for one ordinary request. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Default budget for a realtime execution: the server's realtime run budget is 2 minutes, plus headroom. */
export const DEFAULT_EXECUTE_TIMEOUT_MS = 150_000;

const limit = (ms) => (Number.isFinite(ms) && ms > 0 ? ms : undefined);

export class JasmineClient {
  constructor({
    endpoint = 'http://127.0.0.1:8787',
    apiKey,
    projectId,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    executeTimeoutMs = DEFAULT_EXECUTE_TIMEOUT_MS,
  } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.executeTimeoutMs = executeTimeoutMs;
  }
  headers(extra = {}) {
    return {
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(this.projectId ? { 'x-project-id': this.projectId } : {}),
      ...extra,
    };
  }
  /**
   * One JSON request. `timeoutMs` (default: the client's `timeoutMs`; 0 or Infinity disables it) bounds the whole
   * exchange and rejects with a JasmineError whose code is TIMEOUT. Aborting `signal` rejects with its own reason.
   */
  async request(path, { method = 'GET', body, headers = {}, signal, timeoutMs = this.timeoutMs } = {}) {
    const ms = limit(timeoutMs);
    const timer = ms ? AbortSignal.timeout(ms) : undefined;
    const combined = timer && signal ? AbortSignal.any([signal, timer]) : (timer ?? signal);
    let response, text;
    try {
      response = await this.fetch(this.endpoint + path, {
        method,
        headers: this.headers({ ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: combined,
      });
      text = await response.text();
    } catch (error) {
      if (timer?.aborted && !signal?.aborted)
        throw new JasmineError(`Request to ${path} timed out after ${ms} ms`, 0, undefined, 'TIMEOUT');
      throw error;
    }
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // A proxy error page, an HTML 404, a truncated body…: keep the text for diagnosis.
        throw new JasmineError(
          `${response.ok ? 'Invalid JSON response' : `HTTP ${response.status}`}: ${text.trim().slice(0, 200) || response.statusText}`,
          response.status,
          text,
          response.ok ? 'INVALID_RESPONSE' : undefined,
        );
      }
    }
    if (!response.ok || data?.errors)
      throw new JasmineError(
        data?.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`,
        response.status,
        data,
      );
    return data;
  }
  executeFlow(flowId, payload = {}, { mode = 'realtime', idempotencyKey, version, signal, bypassCache, timeoutMs } = {}) {
    return this.request(`/api/v1/flows/${encodeURIComponent(flowId)}/execute`, {
      method: 'POST',
      body: { payload, mode, ...(version ? { version } : {}) },
      headers: {
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        ...(bypassCache ? { 'x-bypass-cache': 'true' } : {}),
      },
      signal,
      // A realtime call waits for the whole run; an async call returns immediately.
      timeoutMs: timeoutMs ?? (mode === 'async' ? this.timeoutMs : this.executeTimeoutMs),
    });
  }
  checkStatus(requestId, { signal, timeoutMs } = {}) {
    return this.request(`/api/v1/runs/${encodeURIComponent(requestId)}`, { signal, timeoutMs });
  }
  cancel(requestId, { signal, timeoutMs } = {}) {
    return this.request(`/api/v1/runs/${encodeURIComponent(requestId)}/cancel`, { method: 'POST', body: {}, signal, timeoutMs });
  }
  retry(requestId, { signal, timeoutMs } = {}) {
    return this.request(`/api/v1/runs/${encodeURIComponent(requestId)}/retry`, { method: 'POST', body: {}, signal, timeoutMs });
  }
  trace(requestId, { signal, timeoutMs } = {}) {
    return this.request(`/api/v1/runs/${encodeURIComponent(requestId)}/trace`, { signal, timeoutMs });
  }
  /** Polls checkStatus until the run leaves in-progress. `timeoutMs` bounds the whole wait; each poll keeps the client's request timeout. */
  async wait(requestId, { intervalMs = 250, timeoutMs = 120000, signal } = {}) {
    if (!(intervalMs >= 1) || !(timeoutMs >= 1)) throw new RangeError('Polling interval and timeout must be positive');
    const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    for (;;) {
      deadline.throwIfAborted();
      const response = await this.checkStatus(requestId, { signal: deadline });
      if (response.status !== 'in-progress') return response;
      await new Promise((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(deadline.reason);
        };
        const timer = setTimeout(() => {
          deadline.removeEventListener('abort', abort);
          resolve();
        }, intervalMs);
        if (deadline.aborted) abort();
        else deadline.addEventListener('abort', abort, { once: true });
      });
    }
  }
  /**
   * Yield trace, node.token, node.progress and done events; replay is supplied by the server.
   * The stream stays open for the whole run, so no request timeout applies; pass `signal` to stop early.
   */
  async *events(requestId, { signal } = {}) {
    const response = await this.fetch(`${this.endpoint}/api/runs/${encodeURIComponent(requestId)}/events`, {
      headers: this.headers({ accept: 'text/event-stream' }),
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let data;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      throw new JasmineError(
        data?.errors?.map?.((e) => e.message).join('; ') || `Event stream returned HTTP ${response.status}`,
        response.status,
        data,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const event = /^event:\s*(.*)$/m.exec(block)?.[1]?.trim();
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (event && data) {
            yield { event, data: JSON.parse(data) };
            if (event === 'done') return;
          }
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
