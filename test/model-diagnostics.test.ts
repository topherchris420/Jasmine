import { describe, expect, it } from 'vitest';
import { createTestApp, fakeFetch, jsonRequest, withHttp } from './helpers.ts';

const tags = { models: [{ name: 'llama3.2:latest', details: { family: 'llama' } }, { name: 'llava:7b', details: { family: 'llama' } }, { name: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } }] };

describe('Model connection diagnostics', () => {
  it('confirms a healthy server, its models and capabilities, without saving anything', async () => {
    const t = await createTestApp({ fetch: fakeFetch((url) => url.endsWith('/api/tags') ? Response.json(tags) : new Response('no', { status: 404 })) });
    try {
      const before = t.app.connections.list().length;
      const d = await t.app.modelDiagnostics.diagnose({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
      expect(d.ok).toBe(true);
      expect(d.checks.map((c) => [c.id, c.status])).toEqual([['url', 'pass'], ['reach', 'pass'], ['auth', 'pass'], ['api', 'pass'], ['chat', 'pass'], ['embedding', 'pass']]);
      expect(d.capabilities).toEqual({ chat: true, embedding: true, vision: true });
      expect(d.suggested).toEqual({ chatModel: 'llama3.2:latest', embeddingModel: 'nomic-embed-text:latest' });
      expect(d.location.id).toBe('runtime');
      expect(t.app.connections.list()).toHaveLength(before);
    } finally {
      await t.close();
    }
  });

  it('turns each failure into a cause and a recovery path', async () => {
    const respond = (status: number | 'refused' | 'html' | 'hang' | 'empty') => fakeFetch((_url, init) => {
      if (status === 'refused') throw new TypeError('fetch failed');
      if (status === 'html') return new Response('<html>dashboard</html>', { headers: { 'content-type': 'text/html' } });
      if (status === 'empty') return Response.json({ data: [] });
      if (status === 'hang') return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      return new Response('{}', { status });
    });
    const cases: [Parameters<typeof respond>[0], 'ollama' | 'openai', string, string][] = [
      ['refused', 'ollama', 'reach', 'Start Ollama'],
      [401, 'openai', 'auth', 'Check the API key'],
      [404, 'openai', 'api', 'Check the path'],
      ['html', 'openai', 'api', 'Check the port'],
      ['hang', 'openai', 'reach', 'Check the network path'],
      ['empty', 'openai', 'chat', 'Install a chat model'],
    ];
    for (const [behaviour, kind, failed, hint] of cases) {
      const t = await createTestApp({ fetch: respond(behaviour) });
      try {
        const d = await t.app.modelDiagnostics.diagnose({ kind, baseUrl: kind === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234/v1', timeoutMs: 500 });
        expect(d.ok, String(behaviour)).toBe(false);
        expect(d.checks.find((c) => c.id === failed)?.status, String(behaviour)).toBe('fail');
        expect(d.hints.map((h) => h.title), String(behaviour)).toContain(hint);
      } finally {
        await t.close();
      }
    }
    const t = await createTestApp();
    try {
      const bad = await t.app.modelDiagnostics.diagnose({ kind: 'openai', baseUrl: 'ftp://models.example' });
      expect(bad.checks[0]).toMatchObject({ id: 'url', status: 'fail' });
    } finally {
      await t.close();
    }
  });

  it('explains that a hosted runtime cannot reach the visitor’s localhost', async () => {
    const t = await createTestApp({ fetch: fakeFetch(() => { throw new TypeError('fetch failed'); }), env: { LLM_PROVIDER: 'mock', PUBLIC_URL: 'https://studio.example' } });
    try {
      const d = await t.app.modelDiagnostics.diagnose({ kind: 'ollama', baseUrl: 'http://localhost:11434' });
      expect(d.location.detail).toContain('not your computer');
      expect(d.hints[0]!.title).toBe('Your runtime is hosted');
      const remote = await t.app.modelDiagnostics.diagnose({ kind: 'openai', baseUrl: 'http://models.example.com/v1' });
      expect(remote.location).toMatchObject({ id: 'internet', detail: expect.stringContaining('unencrypted') });
      expect((await t.app.modelDiagnostics.diagnose({ kind: 'ollama', baseUrl: 'http://192.168.1.20:11434' })).location.id).toBe('private-network');
    } finally {
      await t.close();
    }
  });

  it('uses a saved connection’s stored key without returning it, and discovers local servers', async () => {
    const seen: string[] = [];
    const fetch = fakeFetch((url, init) => {
      seen.push(`${url} ${(init.headers as Record<string, string>)?.['authorization'] ?? ''}`);
      if (url === 'http://127.0.0.1:11434/api/tags') return Response.json(tags);
      if (url === 'https://provider.example/v1/models') return Response.json({ data: [{ id: 'chat-large' }] });
      throw new TypeError('fetch failed');
    });
    const t = await createTestApp({ fetch });
    try {
      t.app.connections.upsert({ id: 'hosted', name: 'Hosted', kind: 'openai', baseUrl: 'https://provider.example/v1', apiKey: 'sk-test-secret-value-123' });
      t.app.connections.upsert({ id: 'ollama', name: 'Ollama', kind: 'ollama' });
      const d = await t.app.modelDiagnostics.diagnose({ connectionId: 'hosted' });
      expect(d.ok).toBe(true);
      expect(seen).toContain('https://provider.example/v1/models Bearer sk-test-secret-value-123');
      expect(JSON.stringify(d)).not.toContain('sk-test');
      const found = await t.app.modelDiagnostics.discover();
      const ollama = found.servers.find((s) => s.id === 'ollama-local')!;
      expect(ollama).toMatchObject({ ok: true, connectionId: 'ollama' });
      expect(found.servers.filter((s) => s.ok)).toHaveLength(1);
      await withHttp(t.app, async (base) => {
        const req = jsonRequest(base);
        const res = await req('/api/models/diagnose', 'POST', { kind: 'ollama' });
        expect(res.status).toBe(200);
        expect(res.data.suggested.chatModel).toBe('llama3.2:latest');
        expect((await req('/api/models/discover', 'POST', {})).data.servers).toHaveLength(6);
        expect((await req('/api/models/diagnose', 'POST', { kind: 'other' })).status).toBe(400);
      });
    } finally {
      await t.close();
    }
  });
});
