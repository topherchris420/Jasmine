/** Dependency-free Jasmine client for Node.js and browser applications. */
export class JasmineError extends Error {
  constructor(message, status, body) { super(message); this.name = 'JasmineError'; this.status = status; this.body = body; this.code = body?.errors?.[0]?.extensions?.code; }
}
export class JasmineClient {
  constructor({ endpoint = 'http://127.0.0.1:8787', apiKey, projectId, fetch: fetchImpl = globalThis.fetch } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, ''); this.apiKey = apiKey; this.projectId = projectId; this.fetch = fetchImpl;
  }
  headers(extra = {}) { return { ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...(this.projectId ? { 'x-project-id': this.projectId } : {}), ...extra }; }
  async request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    const response = await this.fetch(this.endpoint + path, { method, headers: this.headers({ ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }), ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal });
    const data = await response.json();
    if (!response.ok || data?.errors) throw new JasmineError(data?.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`, response.status, data);
    return data;
  }
  executeFlow(flowId, payload = {}, { mode = 'realtime', idempotencyKey, version, signal } = {}) {
    return this.request(`/api/v1/flows/${encodeURIComponent(flowId)}/execute`, { method: 'POST', body: { payload, mode, ...(version ? { version } : {}) }, ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}), signal });
  }
  checkStatus(requestId, { signal } = {}) { return this.request(`/api/v1/runs/${encodeURIComponent(requestId)}`, { signal }); }
  cancel(requestId) { return this.request(`/api/v1/runs/${encodeURIComponent(requestId)}/cancel`, { method: 'POST', body: {} }); }
  retry(requestId) { return this.request(`/api/v1/runs/${encodeURIComponent(requestId)}/retry`, { method: 'POST', body: {} }); }
  trace(requestId) { return this.request(`/api/v1/runs/${encodeURIComponent(requestId)}/trace`); }
  async wait(requestId, { intervalMs = 250, timeoutMs = 120000, signal } = {}) {
    if (!(intervalMs >= 1) || !(timeoutMs >= 1)) throw new RangeError('Polling interval and timeout must be positive');
    const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    for (;;) {
      deadline.throwIfAborted();
      const response = await this.checkStatus(requestId, { signal: deadline });
      if (response.status !== 'in-progress') return response;
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(deadline.reason); };
        const timer = setTimeout(() => { deadline.removeEventListener('abort', abort); resolve(); }, intervalMs);
        if (deadline.aborted) abort(); else deadline.addEventListener('abort', abort, { once: true });
      });
    }
  }
  /** Yield trace, token, progress, and done events; replay is supplied by the server. */
  async *events(requestId, { signal } = {}) {
    const response = await this.fetch(`${this.endpoint}/api/runs/${encodeURIComponent(requestId)}/events`, { headers: this.headers({ accept: 'text/event-stream' }), signal });
    if (!response.ok || !response.body) throw new JasmineError(`Event stream returned HTTP ${response.status}`, response.status);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
          const event = /^event:\s*(.*)$/m.exec(block)?.[1]?.trim();
          const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (event && data) { yield { event, data: JSON.parse(data) }; if (event === 'done') return; }
        }
        if (done) break;
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
