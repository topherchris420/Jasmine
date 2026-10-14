import Anthropic from '@anthropic-ai/sdk';
import { setTimeout as sleep } from 'node:timers/promises';
import { EngineError, toEngineError } from '../errors.ts';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  maxTokens?: number;
  /** JSON schema the response must satisfy (InstructorLLMNode). */
  jsonSchema?: Record<string, unknown>;
  signal: AbortSignal;
}

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface LLMProvider {
  readonly name: string;
  generate(req: LLMRequest): Promise<LLMResponse>;
}

export interface LLMRouter {
  readonly defaultModel: string;
  provider(name: string | undefined): LLMProvider;
}

export class StaticLLMRouter implements LLMRouter {
  readonly defaultModel: string;
  private readonly providers: Record<string, LLMProvider>;
  private readonly defaultProvider: string;

  constructor(providers: Record<string, LLMProvider>, defaultProvider: string, defaultModel: string) {
    this.providers = providers;
    this.defaultProvider = defaultProvider;
    this.defaultModel = defaultModel;
  }

  provider(name: string | undefined): LLMProvider {
    const p = this.providers[name ?? this.defaultProvider] ?? this.providers[this.defaultProvider];
    if (!p) throw new EngineError('PROVIDER', `No LLM provider registered for "${name}"`);
    return p;
  }
}

export interface MockLLMOptions {
  latencyMs?: number | ((req: LLMRequest, call: number) => number);
  respond?: (req: LLMRequest, call: number) => string;
  /** Return an error to fail this call (fault injection). */
  fail?: (req: LLMRequest, call: number) => EngineError | undefined;
}

/** Deterministic provider for tests and benchmarks; honours cancellation like a real network call. */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  calls = 0;
  private readonly opts: MockLLMOptions;

  constructor(opts: MockLLMOptions = {}) {
    this.opts = opts;
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const call = ++this.calls;
    const latency = typeof this.opts.latencyMs === 'function' ? this.opts.latencyMs(req, call) : (this.opts.latencyMs ?? 0);
    if (latency > 0) await sleep(latency, undefined, { signal: req.signal });
    else req.signal.throwIfAborted();
    const failure = this.opts.fail?.(req, call);
    if (failure) throw failure;
    const prompt = req.messages.map((m) => m.content).join('\n');
    const text = this.opts.respond?.(req, call) ?? (req.jsonSchema ? '{}' : `echo:${prompt}`);
    return { text, inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(text.length / 4), model: req.model };
  }
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export interface AnthropicProviderOptions {
  client?: Anthropic;
  apiKey?: string;
  /** Re-run policy declines on a fallback model server-side (default on). */
  refusalFallback?: boolean;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly refusalFallback: boolean;

  constructor(opts: AnthropicProviderOptions = {}) {
    // maxRetries 0: the engine's per-node retry policy is the only retry layer, so a node with
    // 3 attempts makes at most 3 calls instead of 3 x (1 + SDK retries).
    this.client = opts.client ?? new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), maxRetries: 0 });
    this.refusalFallback = opts.refusalFallback ?? true;
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const fallback = this.refusalFallback && FALLBACK_MODELS.has(req.model);
    try {
      const response = await this.client.beta.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens ?? 16000,
          messages,
          ...(system ? { system } : {}),
          ...(req.jsonSchema ? { output_config: { format: { type: 'json_schema' as const, schema: req.jsonSchema } } } : {}),
          ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal: req.signal },
      );
      if (response.stop_reason === 'refusal') {
        throw new EngineError('PROVIDER', 'The model declined this request', { retryable: false, details: response.stop_details });
      }
      const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return { text, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, model: response.model };
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }
}

export function mapAnthropicError(err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new EngineError('CANCELLED', 'LLM call aborted', { cause: err });
  if (err instanceof Anthropic.APIConnectionError) return new EngineError('NETWORK', err.message, { retryable: true, cause: err });
  if (err instanceof Anthropic.RateLimitError) return new EngineError('RATE_LIMITED', err.message, { retryable: true, cause: err });
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const retryable = status >= 500 || status === 408 || status === 409;
    return new EngineError('PROVIDER', `LLM provider returned ${status}: ${err.message}`, { retryable, cause: err, details: { status } });
  }
  return toEngineError(err);
}

export interface LocalLLMProviderOptions {
  baseURL?: string;
  /** Overrides model names embedded in imported flows. */
  model?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  structuredOutput?: 'json_schema' | 'json_object';
}

/** OpenAI-compatible local inference; no SDK retries or cloud fallback. */
export class LocalLLMProvider implements LLMProvider {
  readonly name = 'local';
  private readonly baseURL: string;
  private readonly opts: LocalLLMProviderOptions;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: LocalLLMProviderOptions = {}) {
    const url = new URL(opts.baseURL ?? 'http://127.0.0.1:1234/v1');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new EngineError('PROVIDER', 'LLM_BASE_URL must be an HTTP(S) API base URL without credentials, query, or fragment');
    }
    this.baseURL = url.href.replace(/\/+$/, '');
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private async request(endpoint: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseURL + endpoint, {
        method: body === undefined ? 'GET' : 'POST', signal, redirect: 'error',
        headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      if (signal.aborted) throw new EngineError('CANCELLED', 'Local model request cancelled', { cause });
      throw new EngineError('NETWORK', 'Cannot reach the local model server; check LLM_BASE_URL and start its API server', { retryable: true, cause });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new EngineError(response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER', `Local model server returned HTTP ${response.status}`, {
        retryable: response.status === 429 || response.status === 408 || response.status >= 500, details: { status: response.status },
      });
    }
    try { return await response.json(); }
    catch (cause) {
      if (signal.aborted) throw new EngineError('CANCELLED', 'Local model request cancelled', { cause });
      throw new EngineError('PROVIDER', 'Local model server returned invalid JSON', { cause });
    }
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    try {
      req.signal.throwIfAborted();
      // Imported cloud model names are deliberately mapped to the configured local model.
      let model = this.opts.model?.trim() || 'auto';
      if (!model || model === 'auto') {
        const listing = await this.request('/models', req.signal) as { data?: { id?: unknown }[] } | null;
        const candidates = Array.isArray(listing?.data) ? listing.data : [];
        const first = candidates.find((entry) => entry && typeof entry.id === 'string' && entry.id.trim() && !/embed/i.test(entry.id));
        if (!first) throw new EngineError('PROVIDER', 'No local chat model is available; load a model or set LLM_MODEL');
        model = first.id as string;
      }
      const jsonMode = this.opts.structuredOutput ?? 'json_schema';
      const messages = req.jsonSchema && jsonMode === 'json_object'
        ? [...req.messages, { role: 'user' as const, content: `Return only JSON matching this schema: ${JSON.stringify(req.jsonSchema)}` }]
        : req.messages;
      const result = await this.request('/chat/completions', req.signal, {
        model, messages, stream: false, max_tokens: req.maxTokens ?? 1024,
        ...(req.jsonSchema ? { response_format: jsonMode === 'json_object'
          ? { type: 'json_object' }
          : { type: 'json_schema', json_schema: { name: 'jasmine_response', strict: true, schema: req.jsonSchema } } } : {}),
      }) as { model?: unknown; choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null;
      const choice = Array.isArray(result?.choices) ? result.choices[0] : undefined;
      if (!choice || typeof choice.message?.content !== 'string') throw new EngineError('PROVIDER', 'Local model response has no assistant text');
      if (choice.finish_reason === 'length') throw new EngineError('PROVIDER', 'Local model response exceeded its token limit; raise maxTokens or shorten the prompt');
      const tokens = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
      return {
        text: choice.message.content,
        inputTokens: tokens(result?.usage?.prompt_tokens), outputTokens: tokens(result?.usage?.completion_tokens),
        model: typeof result?.model === 'string' ? result.model : model,
      };
    } catch (cause) {
      if (req.signal.aborted) throw new EngineError('CANCELLED', 'Local model request cancelled', { cause });
      if (cause instanceof EngineError) throw cause;
      throw new EngineError('PROVIDER', 'Invalid local model response', { cause });
    }
  }
}
