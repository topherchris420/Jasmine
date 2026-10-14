import { describe, expect, it } from 'vitest';
import {
  BuiltinEmbeddingProvider, MockLLMProvider, ModelRouter, OllamaProvider, OpenAICompatibleProvider, chat, embed, lexicalEmbedding,
  type LLMRequest,
} from '../src/llm/providers.ts';
import { fakeFetch } from './helpers.ts';

const request = (changes: Partial<LLMRequest> = {}): LLMRequest => ({
  model: 'auto', messages: [{ role: 'system', content: 'Be precise.' }, { role: 'user', content: 'Explain a firewall.' }],
  signal: new AbortController().signal, ...changes,
});
const completion = { model: 'local-chat', choices: [{ message: { content: 'A firewall filters traffic.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6 } };

describe('OpenAI-compatible provider (LM Studio, llama.cpp, vLLM)', () => {
  it('discovers a chat model for "auto" and preserves messages and usage', async () => {
    const fetch = fakeFetch((url) => Response.json(url.endsWith('/models') ? { data: [{ id: 'text-embedding-small' }, { id: 'local-chat' }] } : completion));
    const req = request();
    const result = await new OpenAICompatibleProvider({ fetch }).generate(req);
    expect(result).toMatchObject({ text: 'A firewall filters traffic.', model: 'local-chat', inputTokens: 12, outputTokens: 6 });
    expect(fetch.calls.map((call) => call.url)).toEqual(['http://127.0.0.1:1234/v1/models', 'http://127.0.0.1:1234/v1/chat/completions']);
    expect(JSON.parse(fetch.calls[1]!.init.body as string)).toMatchObject({ model: 'local-chat', messages: req.messages, stream: false, max_tokens: 1024 });
    expect(fetch.calls[1]!.init.signal).toBe(req.signal);
    expect(fetch.calls[1]!.init.headers).not.toHaveProperty('authorization');
  });

  it('uses an explicit model, optional authentication, and strict JSON-schema output', async () => {
    const fetch = fakeFetch(() => Response.json(completion));
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    await new OpenAICompatibleProvider({ fetch, baseURL: 'http://127.0.0.1:9999/v1/', apiKey: 'test-key' }).generate(request({ model: 'pinned-local', jsonSchema: schema, maxTokens: 256 }));
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.url).toBe('http://127.0.0.1:9999/v1/chat/completions');
    expect(fetch.calls[0]!.init.headers).toHaveProperty('authorization', 'Bearer test-key');
    expect(JSON.parse(fetch.calls[0]!.init.body as string)).toMatchObject({ model: 'pinned-local', max_tokens: 256,
      response_format: { type: 'json_schema', json_schema: { name: 'jasmine_response', strict: true, schema } } });
  });

  it('supports explicit JSON object compatibility mode', async () => {
    const fetch = fakeFetch(() => Response.json(completion));
    await new OpenAICompatibleProvider({ fetch, structuredOutput: 'json_object' }).generate(request({ model: 'local', jsonSchema: { type: 'object' } }));
    const payload = JSON.parse(fetch.calls[0]!.init.body as string);
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.messages.at(-1).content).toContain('Return only JSON matching this schema');
  });

  it('sends tools and parses tool calls, including tool results in follow-up turns', async () => {
    const fetch = fakeFetch(() => Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, finish_reason: 'tool_calls' }] }));
    const res = await new OpenAICompatibleProvider({ fetch }).generate(request({
      model: 'm', tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'lookup', arguments: { q: 'a' } }] }, { role: 'tool', content: 'result', toolCallId: 'c0', name: 'lookup' }],
    }));
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'lookup', arguments: { q: 'x' } }]);
    const body = JSON.parse(fetch.calls[0]!.init.body as string);
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'lookup' } });
    expect(body.messages[1].tool_calls[0]).toMatchObject({ id: 'c0', function: { name: 'lookup', arguments: '{"q":"a"}' } });
    expect(body.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c0', content: 'result' });
  });

  it('streams tokens when asked', async () => {
    const sse = ['data: {"choices":[{"delta":{"content":"Hel"}}]}', 'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}', 'data: {"usage":{"prompt_tokens":3,"completion_tokens":2},"choices":[]}', 'data: [DONE]', ''].join('\n\n');
    const fetch = fakeFetch(() => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));
    const tokens: string[] = [];
    const res = await new OpenAICompatibleProvider({ fetch }).generate(request({ model: 'm', onToken: (t) => tokens.push(t) }));
    expect(tokens).toEqual(['Hel', 'lo']);
    expect(res).toMatchObject({ text: 'Hello', inputTokens: 3, outputTokens: 2 });
    expect(JSON.parse(fetch.calls[0]!.init.body as string)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('creates embeddings in input order', async () => {
    const fetch = fakeFetch(() => Response.json({ model: 'e', data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 4 } }));
    const res = await new OpenAICompatibleProvider({ fetch }).embed({ model: 'e', input: ['a', 'b'], signal: new AbortController().signal });
    expect(res).toEqual({ vectors: [[1, 0], [0, 1]], model: 'e', inputTokens: 4 });
  });

  it('fails clearly when no local chat model exists and makes no completion or cloud request', async () => {
    const fetch = fakeFetch(() => Response.json({ data: [] }));
    await expect(new OpenAICompatibleProvider({ fetch }).generate(request())).rejects.toMatchObject({ code: 'PROVIDER', retryable: false });
    expect(fetch.calls).toHaveLength(1);
  });

  it.each([[429, 'RATE_LIMITED', true], [503, 'PROVIDER', true], [400, 'PROVIDER', false], [401, 'PROVIDER', false]])
    ('maps HTTP %i without leaking response bodies or retrying internally', async (status, code, retryable) => {
      const fetch = fakeFetch(() => new Response('secret provider details', { status: status as number }));
      await expect(new OpenAICompatibleProvider({ fetch }).generate(request({ model: 'local' }))).rejects.toMatchObject({ code, retryable, message: `Local model server returned HTTP ${status}` });
      expect(fetch.calls).toHaveLength(1);
    });

  it('maps connection failure into a retryable error', async () => {
    const fetch = fakeFetch(() => { throw new TypeError('connection refused'); });
    await expect(new OpenAICompatibleProvider({ fetch }).generate(request())).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
  });

  it('rejects invalid JSON, missing assistant content, and truncated generation', async () => {
    for (const response of [new Response('not JSON'), Response.json(null), Response.json({ choices: [] }),
      Response.json({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] })]) {
      const fetch = fakeFetch(() => response);
      await expect(new OpenAICompatibleProvider({ fetch }).generate(request({ model: 'local' }))).rejects.toMatchObject({ code: 'PROVIDER', retryable: false });
    }
  });

  it('handles cancellation before a request and during model inference', async () => {
    const before = new AbortController();
    before.abort();
    const untouched = fakeFetch(() => Response.json(completion));
    await expect(new OpenAICompatibleProvider({ fetch: untouched }).generate(request({ signal: before.signal }))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(untouched.calls).toHaveLength(0);
    const during = new AbortController();
    const fetch = fakeFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      during.abort();
    }));
    await expect(new OpenAICompatibleProvider({ fetch }).generate(request({ model: 'local', signal: during.signal }))).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects base URLs with credentials, queries or fragments', () => {
    expect(() => new OpenAICompatibleProvider({ baseURL: 'http://user:pass@localhost:1234/v1' })).toThrow(/without credentials/);
    expect(() => new OpenAICompatibleProvider({ baseURL: 'file:///etc/passwd' })).toThrow();
  });
});

describe('Ollama provider', () => {
  it('uses /api/chat with options, schema format and native tool calls', async () => {
    const fetch = fakeFetch(() => Response.json({ model: 'llama3.2', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search', arguments: { q: 'x' } } }] }, done: true, done_reason: 'stop', prompt_eval_count: 9, eval_count: 3 }));
    const res = await new OllamaProvider({ fetch }).generate(request({ model: 'llama3.2', maxTokens: 64, temperature: 0.2, jsonSchema: { type: 'object' }, tools: [{ name: 'search', description: 's', parameters: { type: 'object' } }] }));
    expect(fetch.calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(JSON.parse(fetch.calls[0]!.init.body as string)).toMatchObject({ model: 'llama3.2', stream: false, format: { type: 'object' }, options: { num_predict: 64, temperature: 0.2 }, tools: [{ function: { name: 'search' } }] });
    expect(res).toMatchObject({ inputTokens: 9, outputTokens: 3, toolCalls: [{ name: 'search', arguments: { q: 'x' } }] });
  });

  it('discovers chat and embedding models from /api/tags and embeds with /api/embed', async () => {
    const fetch = fakeFetch((url) => url.endsWith('/api/tags')
      ? Response.json({ models: [{ name: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } }, { name: 'qwen2.5:0.5b', details: { family: 'qwen2' } }] })
      : Response.json({ model: 'nomic-embed-text:latest', embeddings: [[0.1, 0.2]], prompt_eval_count: 2 }));
    const provider = new OllamaProvider({ fetch, baseURL: 'http://127.0.0.1:11434/api' });
    expect(await provider.listModels(new AbortController().signal)).toEqual([
      { id: 'nomic-embed-text:latest', kind: 'embedding', family: 'nomic-bert' }, { id: 'qwen2.5:0.5b', kind: 'chat', family: 'qwen2' },
    ]);
    const res = await provider.embed({ model: 'auto', input: ['hello'], signal: new AbortController().signal });
    expect(res).toEqual({ vectors: [[0.1, 0.2]], model: 'nomic-embed-text:latest', inputTokens: 2 });
    expect(JSON.parse(fetch.calls.at(-1)!.init.body as string)).toEqual({ model: 'nomic-embed-text:latest', input: ['hello'] });
  });

  it('streams NDJSON tokens and surfaces "model not found" hints', async () => {
    const body = ['{"message":{"content":"Hi"},"done":false}', '{"message":{"content":" there"},"done":false}', '{"model":"m","done":true,"done_reason":"stop","prompt_eval_count":1,"eval_count":2}', ''].join('\n');
    const tokens: string[] = [];
    const ok = await new OllamaProvider({ fetch: fakeFetch(() => new Response(body)) }).generate(request({ model: 'm', onToken: (t) => tokens.push(t) }));
    expect(tokens).toEqual(['Hi', ' there']);
    expect(ok.text).toBe('Hi there');
    const missing = fakeFetch(() => Response.json({ error: "model 'llama9' not found, try pulling it first" }, { status: 404 }));
    await expect(new OllamaProvider({ fetch: missing }).generate(request({ model: 'llama9' }))).rejects.toThrow(/not found, try pulling/);
  });
});

describe('model router', () => {
  const listing = (ids: string[]) => ({ name: 'ollama', generate: async () => ({ text: '', inputTokens: 0, outputTokens: 0, model: '' }), listModels: async () => ids.map((id) => ({ id, kind: /embed/.test(id) ? 'embedding' as const : 'chat' as const })) });

  it('maps imported cloud models to the default local model and keeps local names', async () => {
    const router = new ModelRouter([
      { id: 'ollama', name: 'Ollama', kind: 'ollama', provider: listing(['llama3.2:latest', 'nomic-embed-text:latest']), chatModel: 'llama3.2', aliases: { 'gpt-4o': 'llama3.2:latest' } },
    ], { defaultChat: 'ollama' });
    expect(await router.resolve({ provider: 'openai', model: 'gpt-4o-mini' }, 'chat')).toMatchObject({ connectionId: 'ollama', model: 'llama3.2', mapped: true });
    expect(await router.resolve({ provider: 'openai', model: 'gpt-4o' }, 'chat')).toMatchObject({ model: 'llama3.2:latest', mapped: true });
    expect(await router.resolve({ model: 'llama3.2' }, 'chat')).toMatchObject({ model: 'llama3.2', mapped: false });
    expect(await router.resolve({ model: 'missing-model' }, 'chat')).toMatchObject({ model: 'llama3.2', mapped: true });
    expect(await router.resolve({ provider: 'ollama', model: 'ollama/llama3.2' }, 'chat')).toMatchObject({ model: 'llama3.2', mapped: false });
    // An explicit connection is trusted: a missing model is reported by the server instead of being swapped silently.
    expect(await router.resolve({ connection: 'ollama', model: 'llama9' }, 'chat')).toMatchObject({ model: 'llama9', mapped: false });
    expect(await router.resolve({}, 'embedding')).toMatchObject({ model: 'nomic-embed-text:latest' });
  });

  it('routes chat() and embed() and never falls back to a cloud provider', async () => {
    const llm = new MockLLMProvider({ respond: () => 'local answer' });
    const router = new ModelRouter([{ id: 'mock', name: 'Mock', kind: 'mock', provider: llm, chatModel: 'mock-model', embeddingModel: 'mock-embed' }]);
    const res = await chat(router, { ref: { provider: 'anthropic', model: 'claude' }, messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal });
    expect(res).toMatchObject({ text: 'local answer', connectionId: 'mock', mapped: true, model: 'mock-model' });
    const vectors = await embed(router, {}, ['a', 'b'], new AbortController().signal);
    expect(vectors.vectors).toHaveLength(2);
    await expect(new ModelRouter([]).resolve({}, 'chat')).rejects.toMatchObject({ code: 'PROVIDER' });
  });
});

describe('built-in lexical embeddings', () => {
  it('are unit length and rank lexically similar text higher', async () => {
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    const q = lexicalEmbedding('reset my password');
    expect(Math.abs(dot(q, q) - 1)).toBeLessThan(1e-9);
    expect(dot(q, lexicalEmbedding('How do I reset a forgotten password?'))).toBeGreaterThan(dot(q, lexicalEmbedding('Quarterly revenue grew by four percent')));
    const res = await new BuiltinEmbeddingProvider().embed({ model: 'x', input: ['a'], signal: new AbortController().signal });
    expect(res.vectors[0]).toHaveLength(384);
    await expect(new BuiltinEmbeddingProvider().generate()).rejects.toMatchObject({ code: 'PROVIDER' });
  });
});
