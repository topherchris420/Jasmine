import { describe, expect, it } from 'vitest';
import { OllamaProvider, OpenAICompatibleProvider, type LLMRequest } from '../src/llm/providers.ts';
import { fakeFetch } from './helpers.ts';

/** A 200 streaming response that delivers `parts` and then either closes or fails like a dropped connection. */
function streaming(parts: string[], end: 'close' | 'reset' | 'hang' = 'close') {
  return fakeFetch(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      if (end === 'close') controller.close();
      if (end === 'reset') controller.error(new TypeError('terminated'));
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
}

const request = (tokens: string[] = [], signal = new AbortController().signal): LLMRequest => ({
  model: 'm', messages: [{ role: 'user', content: 'hi' }], signal, onToken: (t) => tokens.push(t),
});
const sse = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const delta = (content: string, finish?: string) => sse({ choices: [{ delta: { content }, ...(finish ? { finish_reason: finish } : {}) }] });

describe('OpenAI-compatible streaming failures', () => {
  it('fails with a retryable PROVIDER error when the server streams an error chunk', async () => {
    const tokens: string[] = [];
    const fetch = streaming([delta('The answer is'), sse({ error: { message: 'CUDA out of memory', type: 'server_error' } }), sse('[DONE]')]);
    await expect(new OpenAICompatibleProvider({ fetch }).generate(request(tokens)))
      .rejects.toMatchObject({ code: 'PROVIDER', retryable: true, message: expect.stringContaining('CUDA out of memory') });
    expect(tokens).toEqual(['The answer is']);
  });

  it('treats an SSE `event: error` as a failure', async () => {
    const fetch = streaming([delta('Par'), 'event: error\ndata: {"message":"model crashed"}\n\n']);
    await expect(new OpenAICompatibleProvider({ fetch }).generate(request()))
      .rejects.toMatchObject({ code: 'PROVIDER', retryable: true, message: expect.stringContaining('model crashed') });
  });

  it('fails when the stream ends without [DONE] or a finish_reason', async () => {
    const fetch = streaming([delta('Partial ans')]);
    await expect(new OpenAICompatibleProvider({ fetch }).generate(request()))
      .rejects.toMatchObject({ code: 'PROVIDER', retryable: true, message: expect.stringMatching(/ended before the response finished/) });
  });

  it('fails retryably when the connection drops mid-stream', async () => {
    const fetch = streaming([delta('Partial')], 'reset');
    await expect(new OpenAICompatibleProvider({ fetch }).generate(request()))
      .rejects.toMatchObject({ code: 'PROVIDER', retryable: true, message: expect.stringMatching(/interrupted/) });
  });

  it('accepts servers that close after finish_reason without sending [DONE] (llama.cpp, LM Studio, vLLM)', async () => {
    const tokens: string[] = [];
    const fetch = streaming([delta('Hel'), delta('lo', 'stop')]);
    const res = await new OpenAICompatibleProvider({ fetch }).generate(request(tokens));
    expect(res).toMatchObject({ text: 'Hello', finishReason: 'stop' });
    expect(tokens).toEqual(['Hel', 'lo']);
  });

  it('accepts [DONE] without a finish_reason', async () => {
    const fetch = streaming([delta('Hi'), sse('[DONE]')]);
    expect(await new OpenAICompatibleProvider({ fetch }).generate(request())).toMatchObject({ text: 'Hi' });
  });

  it('still reports cancellation, not a provider failure, when the caller aborts mid-stream', async () => {
    const controller = new AbortController();
    const fetch = streaming([delta('Hi')], 'hang');
    const pending = new OpenAICompatibleProvider({ fetch }).generate(request([], controller.signal));
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('Ollama streaming failures', () => {
  const line = (chunk: unknown) => `${JSON.stringify(chunk)}\n`;

  it('fails with a retryable PROVIDER error when the stream ends before done:true', async () => {
    const fetch = streaming([line({ message: { content: 'Partial' }, done: false })]);
    await expect(new OllamaProvider({ fetch }).generate(request()))
      .rejects.toMatchObject({ code: 'PROVIDER', retryable: true, message: expect.stringMatching(/ended before the response finished/) });
  });

  it('fails retryably on an in-stream error line', async () => {
    const fetch = streaming([line({ message: { content: 'Partial' }, done: false }), line({ error: 'llama runner process has terminated' })]);
    await expect(new OllamaProvider({ fetch }).generate(request()))
      .rejects.toMatchObject({ code: 'PROVIDER', retryable: true, message: expect.stringContaining('llama runner process has terminated') });
  });

  it('fails retryably when the connection drops mid-stream', async () => {
    const fetch = streaming([line({ message: { content: 'Partial' }, done: false })], 'reset');
    await expect(new OllamaProvider({ fetch }).generate(request())).rejects.toMatchObject({ code: 'PROVIDER', retryable: true });
  });

  it('returns a complete stream that ends with done:true', async () => {
    const fetch = streaming([line({ message: { content: 'Hi' }, done: false }), line({ model: 'm', message: { content: '' }, done: true, done_reason: 'stop', eval_count: 2 })]);
    expect(await new OllamaProvider({ fetch }).generate(request())).toMatchObject({ text: 'Hi', finishReason: 'stop', outputTokens: 2 });
  });
});
