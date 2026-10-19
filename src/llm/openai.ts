import { EngineError } from '../errors.ts';
import {
  abortedError, DEFAULT_MAX_TOKENS, estimateTokens, guessModelKind, httpError, parseToolArguments, readLines, splitThinking, ThinkingFilter, tokenLimitError, tokensOf, validateBaseUrl,
  type EmbedRequest, type EmbedResponse, type ImageRequest, type LLMMessage, type LLMProvider, type LLMRequest, type LLMResponse, type ModelInfo, type ToolCall,
} from './types.ts';

export interface OpenAICompatibleOptions {
  /** API base including `/v1`. Default: LM Studio on `http://127.0.0.1:1234/v1`. */
  baseURL?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  /** `json_object` for servers without strict JSON-schema output. */
  structuredOutput?: 'json_schema' | 'json_object';
  name?: string;
  defaultMaxTokens?: number;
}

interface OpenAIChoice {
  message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[] };
  finish_reason?: unknown;
}
interface OpenAICompletion {
  model?: unknown;
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/** Thinking sent beside the answer: `reasoning_content` (LM Studio, llama.cpp, vLLM, DeepSeek) or `reasoning`. */
const reasoningOf = (part: { reasoning_content?: unknown; reasoning?: unknown } | undefined): string =>
  typeof part?.reasoning_content === 'string' ? part.reasoning_content : typeof part?.reasoning === 'string' ? part.reasoning : '';

/** Servers that rejected `json_schema` for this many different schemas reject the format itself. */
const FORMAT_REJECTIONS_BEFORE_GLOBAL = 2;

/**
 * OpenAI-compatible local inference (LM Studio, llama.cpp `llama-server`, vLLM, LocalAI, Jan,
 * Ollama's `/v1`). No SDK, no internal retries: the engine's node policy owns retries.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly baseURL: string;
  private readonly opts: OpenAICompatibleOptions;
  private readonly fetchImpl: typeof globalThis.fetch;
  /**
   * Schemas the server rejected as `json_schema` output, so later requests with them go straight to
   * `json_object`. A rejection can come from one schema the server's grammar converter cannot handle, so it
   * applies to every schema only once several different ones have been rejected.
   */
  private readonly jsonObjectSchemas = new Set<string>();
  private jsonObjectOnly = false;

  constructor(opts: OpenAICompatibleOptions = {}) {
    this.baseURL = validateBaseUrl(opts.baseURL ?? 'http://127.0.0.1:1234/v1', 'Model server base URL');
    this.opts = opts;
    this.name = opts.name ?? 'openai-compatible';
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private async send(endpoint: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseURL + endpoint, {
        method: body === undefined ? 'GET' : 'POST', signal, redirect: 'error',
        headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      if (signal.aborted) throw abortedError(signal, `the model server at ${this.baseURL}`, cause);
      throw new EngineError('NETWORK', `Cannot reach the local model server at ${this.baseURL}; start its API server or fix the connection URL`, { retryable: true, cause });
    }
    if (!response.ok) {
      // Some servers (llama-cpp-python, older llama.cpp builds) reject `json_schema` output; generate() then retries with `json_object`.
      const rejectsFormat = (response.status === 400 || response.status === 422 || response.status === 500)
        && typeof (body as { response_format?: unknown } | undefined)?.response_format === 'object'
        && /response_format|json_schema/i.test((await response.text().catch(() => '')).slice(0, 4000));
      if (!rejectsFormat) await response.body?.cancel().catch(() => {});
      const error = httpError('Local model server', response.status);
      if (rejectsFormat) throw new EngineError(error.code, `${error.message}: it does not accept this structured-output format`, { retryable: false, details: { status: response.status, unsupportedResponseFormat: true } });
      throw error;
    }
    return response;
  }

  private async request(endpoint: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await this.send(endpoint, signal, body);
    try {
      return await response.json();
    } catch (cause) {
      if (signal.aborted) throw abortedError(signal, `the model server at ${this.baseURL}`, cause);
      throw new EngineError('PROVIDER', 'Local model server returned invalid JSON', { cause });
    }
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const listing = await this.request('/models', signal) as { data?: { id?: unknown }[] } | null;
    const data = Array.isArray(listing?.data) ? listing.data : [];
    return data
      .filter((m): m is { id: string } => !!m && typeof m.id === 'string' && m.id.trim() !== '')
      .map((m) => ({ id: m.id, kind: guessModelKind(m.id) }));
  }

  private async discover(kind: ModelInfo['kind'], signal: AbortSignal): Promise<string> {
    const found = (await this.listModels(signal)).find((m) => m.kind === kind);
    if (!found) {
      throw new EngineError('PROVIDER', kind === 'chat'
        ? 'No local chat model is available; load a model in your model server or set one on the connection'
        : 'No local embedding model is available; load one (for example nomic-embed-text) or set one on the connection');
    }
    return found.id;
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    try {
      req.signal.throwIfAborted();
      const model = !req.model || req.model === 'auto' ? await this.discover('chat', req.signal) : req.model;
      const schemaKey = req.jsonSchema ? JSON.stringify(req.jsonSchema) : '';
      const knownRejected = this.jsonObjectOnly || this.jsonObjectSchemas.has(schemaKey);
      const jsonMode = knownRejected ? 'json_object' : this.opts.structuredOutput ?? 'json_schema';
      try {
        return await this.complete(req, model, jsonMode, knownRejected);
      } catch (error) {
        const rejected = error instanceof EngineError && (error.details as { unsupportedResponseFormat?: boolean } | undefined)?.unsupportedResponseFormat;
        if (!req.jsonSchema || jsonMode !== 'json_schema' || !rejected) throw error;
        this.jsonObjectSchemas.add(schemaKey);
        if (this.jsonObjectSchemas.size >= FORMAT_REJECTIONS_BEFORE_GLOBAL) this.jsonObjectOnly = true;
        return await this.complete(req, model, 'json_object', true);
      }
    } catch (cause) {
      if (req.signal.aborted) throw abortedError(req.signal, `the model server at ${this.baseURL}`, cause);
      if (cause instanceof EngineError) throw cause;
      throw new EngineError('PROVIDER', 'Invalid local model response', { cause });
    }
  }

  private async complete(req: LLMRequest, model: string, jsonMode: 'json_schema' | 'json_object', fallback = false): Promise<LLMResponse> {
    const messages = req.jsonSchema && jsonMode === 'json_object'
      ? [...req.messages, { role: 'user' as const, content: `Return only JSON matching this schema: ${JSON.stringify(req.jsonSchema)}` }]
      : req.messages;
    const stream = !!req.onToken && !req.tools?.length;
    const body = {
      model, messages: messages.map(toOpenAIMessage), stream,
      max_tokens: req.maxTokens ?? this.opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      // The OpenAI-standard switch, which LM Studio also applies to local reasoning models.
      ...(req.thinking ? { reasoning_effort: req.thinking === 'off' ? 'none' : req.thinking } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
      ...(req.stop?.length ? { stop: req.stop } : {}),
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
      ...(req.jsonSchema ? { response_format: jsonMode === 'json_object'
        ? { type: 'json_object', ...(fallback ? { schema: req.jsonSchema } : {}) }
        : { type: 'json_schema', json_schema: { name: 'jasmine_response', strict: true, schema: req.jsonSchema } } } : {}),
    };
    if (stream) return await this.streamCompletion(body, req, model);
    const result = await this.request('/chat/completions', req.signal, body) as OpenAICompletion | null;
    const choice = Array.isArray(result?.choices) ? result.choices[0] : undefined;
    const toolCalls = parseToolCalls(choice?.message?.tool_calls);
    const content = choice?.message?.content;
    const inline = splitThinking(typeof content === 'string' ? content : '');
    const reasoning = reasoningOf(choice?.message) + inline.reasoning;
    if (choice?.finish_reason === 'length') throw tokenLimitError(inline.answer, reasoning);
    if (!choice || (typeof content !== 'string' && !toolCalls.length && !reasoning)) throw new EngineError('PROVIDER', 'Local model response has no assistant text');
    return {
      text: inline.answer,
      inputTokens: tokensOf(result?.usage?.prompt_tokens), outputTokens: tokensOf(result?.usage?.completion_tokens),
      model: typeof result?.model === 'string' ? result.model : model,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(typeof choice.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  }

  private async streamCompletion(body: Record<string, unknown>, req: LLMRequest, model: string): Promise<LLMResponse> {
    const response = await this.send('/chat/completions', req.signal, body);
    if (!response.body) throw new EngineError('PROVIDER', 'Local model server returned an empty stream');
    let reasoning = '';
    const think = (delta: string) => {
      reasoning += delta;
      req.onReasoning?.(delta);
    };
    const filter = new ThinkingFilter(req.onToken, think);
    let finish: string | undefined;
    let usage: OpenAICompletion['usage'];
    let served = model;
    let ended = false;
    for await (const line of readLines(response.body, req.signal)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        ended = true;
        break;
      }
      let chunk: { model?: unknown; choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: unknown }[]; usage?: OpenAICompletion['usage']; error?: unknown };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) {
        const detail = typeof chunk.error === 'string' ? chunk.error : (chunk.error as { message?: unknown }).message;
        throw new EngineError('PROVIDER', `Local model server reported an error mid-reply: ${String(detail ?? 'unknown error').slice(0, 200)}`);
      }
      if (typeof chunk.model === 'string') served = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      const thought = reasoningOf(choice?.delta);
      if (thought) think(thought);
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta) filter.push(delta);
      if (typeof choice?.finish_reason === 'string') finish = choice.finish_reason;
    }
    req.signal.throwIfAborted();
    filter.end();
    const text = filter.answer;
    // A stream that stops without [DONE] or a finish reason was cut off; a partial or empty answer is not a success.
    if (!ended && !finish) {
      const progress = text ? ` (after ${text.length} characters)` : reasoning ? ' (while the model was still thinking)' : '';
      throw new EngineError('PROVIDER', `Local model server ended the streamed reply before it finished${progress}; check the server's log`, { retryable: true });
    }
    if (finish === 'length') throw tokenLimitError(text, reasoning);
    const prompt = req.messages.map((m) => m.content).join('\n');
    return {
      text, model: served,
      inputTokens: tokensOf(usage?.prompt_tokens) || estimateTokens(prompt),
      outputTokens: tokensOf(usage?.completion_tokens) || estimateTokens(text + reasoning),
      ...(finish ? { finishReason: finish } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  }

  async generateImage(req: ImageRequest): Promise<{ url: string }> {
    const result = await this.request('/images/generations', req.signal, {
      model: req.model === 'auto' ? undefined : req.model, prompt: req.prompt, size: req.size, n: 1, response_format: 'b64_json',
    }) as { data?: { b64_json?: unknown; url?: unknown }[] } | null;
    const first = result?.data?.[0];
    if (typeof first?.b64_json === 'string') return { url: `data:image/png;base64,${first.b64_json}` };
    if (typeof first?.url === 'string') return { url: first.url };
    throw new EngineError('PROVIDER', 'Image server returned no image');
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    try {
      const model = !req.model || req.model === 'auto' ? await this.discover('embedding', req.signal) : req.model;
      if (req.input.length === 0) return { vectors: [], model, inputTokens: 0 };
      const result = await this.request('/embeddings', req.signal, { model, input: req.input }) as {
        data?: { embedding?: unknown; index?: unknown }[]; model?: unknown; usage?: { prompt_tokens?: unknown };
      } | null;
      const data = Array.isArray(result?.data) ? [...result.data] : [];
      data.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
      const vectors = data.map((d) => d.embedding);
      if (vectors.length !== req.input.length || !vectors.every(isVector)) throw new EngineError('PROVIDER', 'Local embedding response is malformed');
      return { vectors: vectors as number[][], model: typeof result?.model === 'string' ? result.model : model, inputTokens: tokensOf(result?.usage?.prompt_tokens) };
    } catch (cause) {
      if (req.signal.aborted) throw abortedError(req.signal, `the model server at ${this.baseURL}`, cause);
      if (cause instanceof EngineError) throw cause;
      throw new EngineError('PROVIDER', 'Invalid embedding response', { cause });
    }
  }
}

export const isVector = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

function toOpenAIMessage(m: LLMMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content, ...(m.name ? { name: m.name } : {}) };
  const content = m.images?.length
    ? [{ type: 'text', text: m.content }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : m.content;
  return {
    role: m.role, content,
    ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}),
  };
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is { id?: unknown; function: { name: string; arguments?: unknown } } => typeof c?.function?.name === 'string')
    .map((c, i) => ({ id: typeof c.id === 'string' && c.id ? c.id : `call_${i}`, name: c.function.name, arguments: parseToolArguments(c.function.arguments) }));
}
