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
    expect(JSON.parse(fetch.calls[1]!.init.body as string)).toMatchObject({ model: 'local-chat', messages: req.messages, stream: false, max_tokens: 4096 });
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

  it('falls back to JSON object mode once a server rejects JSON-schema output, and remembers it', async () => {
    const schema = { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] };
    const fetch = fakeFetch((_url, init) => (JSON.parse(init.body as string).response_format?.type === 'json_schema'
      ? new Response(JSON.stringify({ error: { message: "response_format.type: Input should be 'text' or 'json_object'" } }), { status: 500 })
      : Response.json(completion)));
    const provider = new OpenAICompatibleProvider({ fetch });
    await expect(provider.generate(request({ model: 'local', jsonSchema: schema }))).resolves.toMatchObject({ text: 'A firewall filters traffic.' });
    await provider.generate(request({ model: 'local', jsonSchema: schema }));
    const formats = fetch.calls.map((call) => JSON.parse(call.init.body as string).response_format);
    expect(formats).toEqual([
      { type: 'json_schema', json_schema: { name: 'jasmine_response', strict: true, schema } },
      { type: 'json_object', schema },
      { type: 'json_object', schema },
    ]);
  });

  it('does not retry server errors unrelated to the output format', async () => {
    const fetch = fakeFetch(() => new Response('model crashed', { status: 500 }));
    await expect(new OpenAICompatibleProvider({ fetch }).generate(request({ model: 'local', jsonSchema: { type: 'object' } }))).rejects.toMatchObject({ code: 'PROVIDER', message: 'Local model server returned HTTP 500' });
    expect(fetch.calls).toHaveLength(1);
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

  it('fails instead of returning a partial answer when the stream is cut off or reports an error', async () => {
    const sse = (lines: string[]) => fakeFetch(() => new Response([...lines, ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } }));
    const run = (fetch: typeof globalThis.fetch) => new OpenAICompatibleProvider({ fetch }).generate(request({ model: 'm', onToken: () => {} }));
    await expect(run(sse(['data: {"choices":[{"delta":{"role":"assistant"}}]}']))).rejects.toMatchObject({ code: 'PROVIDER', retryable: true, message: expect.stringContaining('ended the streamed reply before it finished') });
    await expect(run(sse(['data: {"choices":[{"delta":{"content":"Partial"}}]}']))).rejects.toThrow(/after 7 characters/);
    await expect(run(sse(['data: {"choices":[{"delta":{"content":"Hi"}}]}', 'data: {"error":{"message":"out of memory"}}']))).rejects.toThrow(/error mid-reply: out of memory/);
    // A finish reason without [DONE] is a complete reply.
    await expect(run(sse(['data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}']))).resolves.toMatchObject({ text: 'Done' });
  });

  it('keeps a reasoning model\'s thinking out of the answer, from reasoning fields or inline <think> tags', async () => {
    const sse = (lines: string[]) => fakeFetch(() => new Response([...lines, 'data: [DONE]', ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } }));
    const delta = (d: Record<string, string>, finish?: string) => `data: ${JSON.stringify({ choices: [{ delta: d, ...(finish ? { finish_reason: finish } : {}) }] })}`;
    const stream = async (fetch: typeof globalThis.fetch) => {
      const tokens: string[] = [];
      const thoughts: string[] = [];
      const res = await new OpenAICompatibleProvider({ fetch }).generate(request({ model: 'm', onToken: (t) => tokens.push(t), onReasoning: (t) => thoughts.push(t) }));
      return { res, tokens: tokens.join(''), thoughts: thoughts.join('') };
    };
    // LM Studio, llama.cpp and vLLM with a reasoning parser: `reasoning_content`; OpenRouter-style servers: `reasoning`.
    const separate = await stream(sse([delta({ reasoning_content: 'The user wants ' }), delta({ reasoning: 'a definition.' }), delta({ content: 'A firewall ' }), delta({ content: 'filters traffic.' }, 'stop')]));
    expect(separate).toMatchObject({ tokens: 'A firewall filters traffic.', thoughts: 'The user wants a definition.', res: { text: 'A firewall filters traffic.', reasoning: 'The user wants a definition.' } });
    // Without a reasoning parser the thinking arrives inline, with tags split across chunks.
    const inline = await stream(sse([delta({ content: '\n<thi' }), delta({ content: 'nk>Plan the answer.</th' }), delta({ content: 'ink>\n\nA firewall' }), delta({ content: ' filters traffic.' }, 'stop')]));
    expect(inline).toMatchObject({ tokens: 'A firewall filters traffic.', thoughts: 'Plan the answer.', res: { text: 'A firewall filters traffic.', reasoning: 'Plan the answer.' } });
    // Templates that open the tag in the prompt emit only the closing tag; the final text still drops the thinking.
    const orphan = await stream(sse([delta({ content: 'Plan the answer.\n</think>\n\n' }), delta({ content: 'A firewall filters traffic.' }, 'stop')]));
    expect(orphan.res).toMatchObject({ text: 'A firewall filters traffic.', reasoning: 'Plan the answer.\n' });
    const orphanThinking = await stream(sse([delta({ content: 'Plan the answer. </thinking>' }), delta({ content: ' A firewall filters traffic.' }, 'stop')]));
    expect(orphanThinking.res).toMatchObject({ text: 'A firewall filters traffic.', reasoning: 'Plan the answer. ' });
    // A reply without tags is passed through unchanged, including one that only mentions a tag later on.
    const plain = await stream(sse([delta({ content: '<b>Use' }), delta({ content: ' <think> tags.</b>' }, 'stop')]));
    expect(plain).toMatchObject({ tokens: '<b>Use <think> tags.</b>', thoughts: '', res: { text: '<b>Use <think> tags.</b>' } });
    expect(plain.res).not.toHaveProperty('reasoning');

    const nonStreaming = fakeFetch(() => Response.json({ choices: [{ message: { content: '<think>Classify it.</think>{"category":"Complaint"}' }, finish_reason: 'stop' }] }));
    const structured = await new OpenAICompatibleProvider({ fetch: nonStreaming }).generate(request({ model: 'm', jsonSchema: { type: 'object' } }));
    expect(structured).toMatchObject({ text: '{"category":"Complaint"}', reasoning: 'Classify it.' });
  });

  it('says when a reasoning model spent its whole token limit thinking, and when a stream was cut off mid-thought', async () => {
    const thinkingOnly = fakeFetch(() => Response.json({ choices: [{ message: { content: '', reasoning_content: 'Let me think about firewalls at length' }, finish_reason: 'length' }] }));
    await expect(new OpenAICompatibleProvider({ fetch: thinkingOnly }).generate(request({ model: 'm' }))).rejects.toThrow(/whole token limit thinking \(38 characters of reasoning\) and wrote no answer; set Thinking to Off/);
    const cut = fakeFetch(() => new Response(['data: {"choices":[{"delta":{"reasoning_content":"Hmm"}}]}', ''].join('\n\n')));
    await expect(new OpenAICompatibleProvider({ fetch: cut }).generate(request({ model: 'm', onToken: () => {} }))).rejects.toThrow(/before it finished \(while the model was still thinking\)/);
    // An answer cut off by the limit keeps the usual message.
    const long = fakeFetch(() => Response.json({ choices: [{ message: { content: 'A firewall', reasoning_content: 'ok' }, finish_reason: 'length' }] }));
    await expect(new OpenAICompatibleProvider({ fetch: long }).generate(request({ model: 'm' }))).rejects.toThrow('Local model response exceeded its token limit');
  });

  it('sends the Thinking setting only when a step sets it', async () => {
    const fetch = fakeFetch(() => Response.json(completion));
    const provider = new OpenAICompatibleProvider({ fetch });
    await provider.generate(request({ model: 'm' }));
    await provider.generate(request({ model: 'm', thinking: 'off' }));
    await provider.generate(request({ model: 'm', thinking: 'high' }));
    expect(fetch.calls.map((call) => JSON.parse(call.init.body as string).reasoning_effort)).toEqual([undefined, 'none', 'high']);
    const ollama = fakeFetch(() => Response.json({ model: 'm', message: { content: 'ok' }, done: true }));
    for (const [model, thinking] of [['qwen3', undefined], ['qwen3', 'off'], ['qwen3', 'low'], ['gpt-oss:20b', 'low']] as const) {
      await new OllamaProvider({ fetch: ollama }).generate(request({ model, ...(thinking ? { thinking } : {}) }));
    }
    expect(ollama.calls.map((call) => JSON.parse(call.init.body as string).think)).toEqual([undefined, false, true, 'low']);
  });

  it('drops the Thinking setting for a model whose server rejects it, and remembers that', async () => {
    // OpenAI's API answers this for models without reasoning; Ollama says the model "does not support thinking".
    const openai = fakeFetch((_url, init) => (JSON.parse(init.body as string).reasoning_effort !== undefined
      ? Response.json({ error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model." } }, { status: 400 })
      : Response.json(completion)));
    const provider = new OpenAICompatibleProvider({ fetch: openai });
    await expect(provider.generate(request({ model: 'gpt-4o-mini', thinking: 'off' }))).resolves.toMatchObject({ text: 'A firewall filters traffic.' });
    await provider.generate(request({ model: 'gpt-4o-mini', thinking: 'off' }));
    await provider.generate(request({ model: 'o4-mini', thinking: 'low' }));
    expect(openai.calls.map((call) => JSON.parse(call.init.body as string).reasoning_effort)).toEqual(['none', undefined, undefined, 'low', undefined]);
    // Other 400s are not mistaken for a rejected setting.
    const broken = fakeFetch(() => Response.json({ error: { message: 'context length exceeded' } }, { status: 400 }));
    await expect(new OpenAICompatibleProvider({ fetch: broken }).generate(request({ model: 'm', thinking: 'off' }))).rejects.toThrow('Local model server returned HTTP 400');
    expect(broken.calls).toHaveLength(1);

    const ollama = fakeFetch((_url, init) => (JSON.parse(init.body as string).think !== undefined
      ? Response.json({ error: '"llama3.2" does not support thinking' }, { status: 400 })
      : Response.json({ model: 'llama3.2', message: { content: 'ok' }, done: true })));
    const local = new OllamaProvider({ fetch: ollama });
    await expect(local.generate(request({ model: 'llama3.2', thinking: 'off' }))).resolves.toMatchObject({ text: 'ok' });
    await local.generate(request({ model: 'llama3.2', thinking: 'off' }));
    expect(ollama.calls.map((call) => JSON.parse(call.init.body as string).think)).toEqual([false, undefined, undefined]);
  });

  it('remembers a refused Thinking level per model and level, and ignores errors that only mention reasoning', async () => {
    // o-series models accept low/medium/high but have no "none".
    const fetch = fakeFetch((_url, init) => (JSON.parse(init.body as string).reasoning_effort === 'none'
      ? Response.json({ error: { message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model." } }, { status: 400 })
      : Response.json(completion)));
    const provider = new OpenAICompatibleProvider({ fetch });
    await provider.generate(request({ model: 'o4-mini', thinking: 'off' }));
    await provider.generate(request({ model: 'o4-mini', thinking: 'high' }));
    await provider.generate(request({ model: 'o4-mini', thinking: 'off' }));
    expect(fetch.calls.map((call) => JSON.parse(call.init.body as string).reasoning_effort)).toEqual(['none', undefined, 'high', undefined]);
    // A model whose name contains "reasoning" hitting an unrelated error is not mistaken for a refused setting.
    const unrelated = fakeFetch(() => Response.json({ error: { message: 'Phi-4-reasoning: invalid message role' } }, { status: 400 }));
    await expect(new OpenAICompatibleProvider({ fetch: unrelated }).generate(request({ model: 'Phi-4-reasoning', thinking: 'high' }))).rejects.toThrow('Local model server returned HTTP 400');
    expect(unrelated.calls).toHaveLength(1);
    // Ollama's "not found" for a model named "…thinking…" keeps its pull hint and is not a refused setting.
    const missing = fakeFetch(() => Response.json({ error: "model 'qwen3:4b-thinking-2507' not found, try pulling it first" }, { status: 404 }));
    await expect(new OllamaProvider({ fetch: missing }).generate(request({ model: 'qwen3:4b-thinking-2507', thinking: 'low' }))).rejects.toThrow(/not found, try pulling/);
    expect(missing.calls).toHaveLength(1);
  });

  it('retries a default output budget smaller when prompt plus budget exceed a server\'s context', async () => {
    const budgets: unknown[] = [];
    const fetch = fakeFetch((_url, init) => {
      const max = JSON.parse(init.body as string).max_tokens;
      budgets.push(max);
      return max > 2048
        ? Response.json({ error: { message: "This model's maximum context length is 4096 tokens. However, you requested 4596 tokens (500 in the messages, 4096 in the completion)." } }, { status: 400 })
        : Response.json(completion);
    });
    await expect(new OpenAICompatibleProvider({ fetch }).generate(request({ model: 'm' }))).resolves.toMatchObject({ text: 'A firewall filters traffic.' });
    expect(budgets).toEqual([4096, 1024]);
    // A budget the step chose is the step's decision: the error is reported, not worked around.
    await expect(new OpenAICompatibleProvider({ fetch }).generate(request({ model: 'm', maxTokens: 3000 }))).rejects.toThrow(/longer than the model's context/);
    expect(budgets).toEqual([4096, 1024, 3000]);
  });

  it('reports a reply with thinking but no answer as a failure, streamed or not, instead of a blank success', async () => {
    const onlyThinking = { code: 'PROVIDER', retryable: true, message: 'The model returned only its thinking and no answer' };
    const openai = (handler: () => Response, streamed: boolean) => new OpenAICompatibleProvider({ fetch: fakeFetch(handler) }).generate(request({ model: 'm', ...(streamed ? { onToken: () => {} } : {}) }));
    for (const content of [null, '', '  \n']) {
      await expect(openai(() => Response.json({ choices: [{ message: { content, reasoning_content: 'Let me think.' }, finish_reason: 'stop' }] }), false)).rejects.toMatchObject(onlyThinking);
    }
    await expect(openai(() => Response.json({ choices: [{ message: { content: '<think>Let me think.</think>' }, finish_reason: 'stop' }] }), false)).rejects.toMatchObject(onlyThinking);
    const sse = ['data: {"choices":[{"delta":{"reasoning_content":"Let me think."}}]}', 'data: {"choices":[{"delta":{"content":"\\n"},"finish_reason":"stop"}]}', 'data: [DONE]', ''].join('\n\n');
    await expect(openai(() => new Response(sse), true)).rejects.toMatchObject(onlyThinking);
    const ndjson = ['{"message":{"thinking":"Let me think."},"done":false}', '{"model":"m","done":true,"done_reason":"stop"}', ''].join('\n');
    await expect(new OllamaProvider({ fetch: fakeFetch(() => new Response(ndjson)) }).generate(request({ model: 'm', onToken: () => {} }))).rejects.toMatchObject(onlyThinking);
    // Without thinking, an empty reply stays a (labelled) empty answer, as before.
    await expect(openai(() => Response.json({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }), false)).resolves.toMatchObject({ text: '' });
    // Tool calls are an answer even with no text.
    const tools = fakeFetch(() => Response.json({ choices: [{ message: { content: '', reasoning_content: 'Use the tool.', tool_calls: [{ id: 'c1', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
    await expect(new OpenAICompatibleProvider({ fetch: tools }).generate(request({ model: 'm', tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object' } }] }))).resolves.toMatchObject({ toolCalls: [{ name: 'lookup' }] });
  });

  it('falls back to JSON object mode only for the schema a server rejected, until several schemas fail', async () => {
    const rejected = (schema: unknown) => JSON.stringify(schema).includes('"pattern"');
    const fetch = fakeFetch((_url, init) => {
      const body = JSON.parse(init.body as string);
      return body.response_format?.type === 'json_schema' && rejected(body.response_format.json_schema.schema)
        ? new Response('failed to convert json_schema to grammar', { status: 500 })
        : Response.json(completion);
    });
    const provider = new OpenAICompatibleProvider({ fetch });
    const odd = { type: 'object', properties: { code: { type: 'string', pattern: '^[A-Z]{3}$' } } };
    const normal = { type: 'object', properties: { category: { type: 'string' } } };
    await provider.generate(request({ model: 'local', jsonSchema: odd }));
    await provider.generate(request({ model: 'local', jsonSchema: odd }));
    await provider.generate(request({ model: 'local', jsonSchema: normal }));
    expect(fetch.calls.map((call) => JSON.parse(call.init.body as string).response_format.type)).toEqual(['json_schema', 'json_object', 'json_object', 'json_schema']);
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
    const cut = ['{"message":{"content":"Hi"},"done":false}', ''].join('\n');
    await expect(new OllamaProvider({ fetch: fakeFetch(() => new Response(cut)) }).generate(request({ model: 'm', onToken: () => {} }))).rejects.toThrow(/Ollama ended the streamed reply before it finished \(after 2 characters\)/);
    const thinking = ['{"message":{"thinking":"Greet them."},"done":false}', '{"message":{"content":"Hi"},"done":false}', '{"model":"m","done":true,"done_reason":"stop"}', ''].join('\n');
    const thoughts: string[] = [];
    const reasoned = await new OllamaProvider({ fetch: fakeFetch(() => new Response(thinking)) }).generate(request({ model: 'm', onToken: () => {}, onReasoning: (t) => thoughts.push(t) }));
    expect(reasoned).toMatchObject({ text: 'Hi', reasoning: 'Greet them.' });
    expect(thoughts).toEqual(['Greet them.']);
    const inline = await new OllamaProvider({ fetch: fakeFetch(() => Response.json({ model: 'm', message: { content: '<think>Greet them.</think>\nHi' }, done: true, done_reason: 'stop' })) }).generate(request({ model: 'm' }));
    expect(inline).toMatchObject({ text: 'Hi', reasoning: 'Greet them.' });
    const budget = fakeFetch(() => Response.json({ model: 'm', message: { content: '', thinking: 'Greet them warmly' }, done: true, done_reason: 'length' }));
    await expect(new OllamaProvider({ fetch: budget }).generate(request({ model: 'm' }))).rejects.toThrow(/whole token limit thinking/);
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
