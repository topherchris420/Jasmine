import { describe, expect, it } from 'vitest';
import { LocalLLMProvider, type LLMRequest } from '../src/llm/providers.ts';
import { fakeFetch } from './helpers.ts';

const request = (changes: Partial<LLMRequest> = {}): LLMRequest => ({
  model: 'imported-cloud-model', messages: [{ role: 'system', content: 'Be precise.' }, { role: 'user', content: 'Explain a firewall.' }],
  signal: new AbortController().signal, ...changes,
});
const completion = { model: 'local-chat', choices: [{ message: { content: 'A firewall filters traffic.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6 } };

describe('local model provider', () => {
  it('discovers a chat model, maps imported model names locally, and preserves messages and usage', async () => {
    const fetch = fakeFetch((url) => Response.json(url.endsWith('/models')
      ? { data: [{ id: 'text-embedding-small' }, { id: 'local-chat' }] } : completion));
    const req = request();
    const result = await new LocalLLMProvider({ fetch }).generate(req);
    expect(result).toEqual({ text: 'A firewall filters traffic.', model: 'local-chat', inputTokens: 12, outputTokens: 6 });
    expect(fetch.calls.map((call) => call.url)).toEqual(['http://127.0.0.1:1234/v1/models', 'http://127.0.0.1:1234/v1/chat/completions']);
    expect(JSON.parse(fetch.calls[1]!.init.body as string)).toMatchObject({ model: 'local-chat', messages: req.messages, stream: false, max_tokens: 1024 });
    expect(fetch.calls[1]!.init.signal).toBe(req.signal);
    expect(fetch.calls[1]!.init.headers).not.toHaveProperty('authorization');
  });

  it('uses a pinned local model, optional authentication, and structured output without discovery', async () => {
    const fetch = fakeFetch(() => Response.json(completion));
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    await new LocalLLMProvider({ fetch, baseURL: 'http://127.0.0.1:9999/v1/', model: 'pinned-local', apiKey: 'test-key' })
      .generate(request({ jsonSchema: schema, maxTokens: 256 }));
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.url).toBe('http://127.0.0.1:9999/v1/chat/completions');
    expect(fetch.calls[0]!.init.headers).toHaveProperty('authorization', 'Bearer test-key');
    expect(JSON.parse(fetch.calls[0]!.init.body as string)).toMatchObject({ model: 'pinned-local', max_tokens: 256,
      response_format: { type: 'json_schema', json_schema: { name: 'jasmine_response', strict: true, schema } } });
  });

  it('supports explicit JSON object compatibility mode', async () => {
    const fetch = fakeFetch(() => Response.json(completion));
    await new LocalLLMProvider({ fetch, model: 'local', structuredOutput: 'json_object' }).generate(request({ jsonSchema: { type: 'object' } }));
    const payload = JSON.parse(fetch.calls[0]!.init.body as string);
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.messages.at(-1).content).toContain('Return only JSON matching this schema');
  });

  it('fails clearly when no local chat model exists and makes no completion or cloud request', async () => {
    const fetch = fakeFetch(() => Response.json({ data: [] }));
    await expect(new LocalLLMProvider({ fetch }).generate(request())).rejects.toMatchObject({ code: 'PROVIDER', retryable: false });
    expect(fetch.calls).toHaveLength(1);
  });

  it.each([[429, 'RATE_LIMITED', true], [503, 'PROVIDER', true], [400, 'PROVIDER', false], [401, 'PROVIDER', false]])
    ('maps HTTP %i without leaking response bodies or retrying internally', async (status, code, retryable) => {
      const fetch = fakeFetch(() => new Response('secret provider details', { status: status as number }));
      await expect(new LocalLLMProvider({ fetch, model: 'local' }).generate(request())).rejects.toMatchObject({ code, retryable, message: `Local model server returned HTTP ${status}` });
      expect(fetch.calls).toHaveLength(1);
    });

  it('maps connection failure into a retryable error', async () => {
    const fetch = fakeFetch(() => { throw new TypeError('connection refused'); });
    await expect(new LocalLLMProvider({ fetch }).generate(request())).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
  });

  it('rejects invalid JSON, missing assistant content, and truncated generation', async () => {
    for (const response of [new Response('not JSON'), Response.json(null), Response.json({ choices: [] }),
      Response.json({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] })]) {
      const fetch = fakeFetch(() => response);
      await expect(new LocalLLMProvider({ fetch, model: 'local' }).generate(request())).rejects.toMatchObject({ code: 'PROVIDER', retryable: false });
    }
  });

  it('handles cancellation before a request and during model inference', async () => {
    const before = new AbortController();
    before.abort();
    const untouched = fakeFetch(() => Response.json(completion));
    await expect(new LocalLLMProvider({ fetch: untouched }).generate(request({ signal: before.signal }))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(untouched.calls).toHaveLength(0);
    const during = new AbortController();
    const fetch = fakeFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      during.abort();
    }));
    await expect(new LocalLLMProvider({ fetch, model: 'local' }).generate(request({ signal: during.signal }))).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
