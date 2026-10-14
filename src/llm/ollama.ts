import { EngineError } from '../errors.ts';
import { isVector } from './openai.ts';
import {
  guessModelKind, httpError, parseToolArguments, readLines, tokensOf, validateBaseUrl,
  type EmbedRequest, type EmbedResponse, type LLMMessage, type LLMProvider, type LLMRequest, type LLMResponse, type ModelInfo, type ToolCall,
} from './types.ts';

export interface OllamaOptions {
  /** Server root, default `http://127.0.0.1:11434`. */
  baseURL?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  name?: string;
  defaultMaxTokens?: number;
  /** How long Ollama keeps a model loaded after a request (e.g. "5m"). */
  keepAlive?: string;
}

interface OllamaChatChunk {
  model?: unknown;
  message?: { content?: unknown; tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[] };
  done?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  error?: unknown;
}

/** Native Ollama API: `/api/chat`, `/api/embed`, `/api/tags`. */
export class OllamaProvider implements LLMProvider {
  readonly name: string;
  readonly baseURL: string;
  private readonly opts: OllamaOptions;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OllamaOptions = {}) {
    this.baseURL = validateBaseUrl(opts.baseURL ?? 'http://127.0.0.1:11434', 'Ollama base URL').replace(/\/(api|v1)$/, '');
    this.opts = opts;
    this.name = opts.name ?? 'ollama';
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
      if (signal.aborted) throw new EngineError('CANCELLED', 'Ollama request cancelled', { cause });
      throw new EngineError('NETWORK', `Cannot reach Ollama at ${this.baseURL}; run \`ollama serve\` or fix the connection URL`, { retryable: true, cause });
    }
    if (!response.ok) {
      let detail = '';
      try {
        const payload = await response.json() as { error?: unknown };
        if (typeof payload?.error === 'string' && /not found|pull/i.test(payload.error)) detail = `: ${payload.error.slice(0, 200)}`;
      } catch {
        /* body is not JSON */
      }
      const err = httpError('Ollama', response.status);
      throw detail ? new EngineError(err.code, err.message + detail, { retryable: err.retryable, details: err.details }) : err;
    }
    return response;
  }

  private async request(endpoint: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await this.send(endpoint, signal, body);
    try {
      return await response.json();
    } catch (cause) {
      if (signal.aborted) throw new EngineError('CANCELLED', 'Ollama request cancelled', { cause });
      throw new EngineError('PROVIDER', 'Ollama returned invalid JSON', { cause });
    }
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const tags = await this.request('/api/tags', signal) as { models?: { name?: unknown; model?: unknown; size?: unknown; details?: { family?: unknown; families?: unknown } }[] } | null;
    const models = Array.isArray(tags?.models) ? tags.models : [];
    return models.flatMap((m) => {
      const id = typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : '';
      if (!id) return [];
      const family = typeof m.details?.family === 'string' ? m.details.family : undefined;
      return [{ id, kind: guessModelKind(id, family), ...(typeof m.size === 'number' ? { sizeBytes: m.size } : {}), ...(family ? { family } : {}) }];
    });
  }

  private async discover(kind: ModelInfo['kind'], signal: AbortSignal): Promise<string> {
    const found = (await this.listModels(signal)).find((m) => m.kind === kind);
    if (!found) {
      throw new EngineError('PROVIDER', kind === 'chat'
        ? 'Ollama has no chat model; run `ollama pull llama3.2` (or another model) or set one on the connection'
        : 'Ollama has no embedding model; run `ollama pull nomic-embed-text` or set one on the connection');
    }
    return found.id;
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    try {
      req.signal.throwIfAborted();
      const model = !req.model || req.model === 'auto' ? await this.discover('chat', req.signal) : req.model;
      const stream = !!req.onToken && !req.tools?.length;
      const options = {
        num_predict: req.maxTokens ?? this.opts.defaultMaxTokens ?? 1024,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.topP !== undefined ? { top_p: req.topP } : {}),
        ...(req.stop?.length ? { stop: req.stop } : {}),
      };
      const body = {
        model, stream, options, messages: req.messages.map(toOllamaMessage),
        ...(this.opts.keepAlive ? { keep_alive: this.opts.keepAlive } : {}),
        ...(req.jsonSchema ? { format: req.jsonSchema } : {}),
        ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
      };
      let last: OllamaChatChunk;
      let text = '';
      let toolCalls: ToolCall[] = [];
      if (stream) {
        const response = await this.send('/api/chat', req.signal, body);
        if (!response.body) throw new EngineError('PROVIDER', 'Ollama returned an empty stream');
        last = {};
        let done = false;
        try {
          for await (const line of readLines(response.body, req.signal)) {
            let chunk: OllamaChatChunk;
            try {
              chunk = JSON.parse(line);
            } catch {
              continue;
            }
            if (!chunk || typeof chunk !== 'object') continue;
            // A failure after the 200 response (model crash, out of memory) arrives as an error line.
            if (chunk.error !== undefined && chunk.error !== null) {
              const detail = typeof chunk.error === 'string' ? chunk.error : JSON.stringify(chunk.error);
              throw new EngineError('PROVIDER', `Ollama failed while streaming: ${detail.slice(0, 200)}`, { retryable: true });
            }
            const delta = chunk.message?.content;
            if (typeof delta === 'string' && delta) {
              text += delta;
              req.onToken?.(delta);
            }
            if (chunk.done === true) {
              last = chunk;
              done = true;
            }
          }
        } catch (cause) {
          if (req.signal.aborted || cause instanceof EngineError) throw cause;
          throw new EngineError('PROVIDER', 'Ollama stream was interrupted before the response finished', { retryable: true, cause });
        }
        req.signal.throwIfAborted();
        // Ollama always ends a stream with a `done: true` line; without it the response was cut off.
        if (!done) throw new EngineError('PROVIDER', 'Ollama stream ended before the response finished', { retryable: true });
      } else {
        last = (await this.request('/api/chat', req.signal, body) ?? {}) as OllamaChatChunk;
        if (typeof last.message?.content !== 'string' && !Array.isArray(last.message?.tool_calls)) throw new EngineError('PROVIDER', 'Ollama response has no assistant message');
        text = typeof last.message?.content === 'string' ? last.message.content : '';
        toolCalls = parseToolCalls(last.message?.tool_calls);
      }
      if (last.done_reason === 'length') throw new EngineError('PROVIDER', 'Local model response exceeded its token limit; raise maxTokens or shorten the prompt');
      return {
        text, model: typeof last.model === 'string' ? last.model : model,
        inputTokens: tokensOf(last.prompt_eval_count), outputTokens: tokensOf(last.eval_count),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(typeof last.done_reason === 'string' ? { finishReason: last.done_reason } : {}),
      };
    } catch (cause) {
      if (req.signal.aborted) throw new EngineError('CANCELLED', 'Ollama request cancelled', { cause });
      if (cause instanceof EngineError) throw cause;
      throw new EngineError('PROVIDER', 'Invalid Ollama response', { cause });
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    try {
      const model = !req.model || req.model === 'auto' ? await this.discover('embedding', req.signal) : req.model;
      if (req.input.length === 0) return { vectors: [], model, inputTokens: 0 };
      const result = await this.request('/api/embed', req.signal, {
        model, input: req.input, ...(this.opts.keepAlive ? { keep_alive: this.opts.keepAlive } : {}),
      }) as { embeddings?: unknown[]; model?: unknown; prompt_eval_count?: unknown } | null;
      const vectors = Array.isArray(result?.embeddings) ? result.embeddings : [];
      if (vectors.length !== req.input.length || !vectors.every(isVector)) throw new EngineError('PROVIDER', 'Ollama embedding response is malformed');
      return { vectors: vectors as number[][], model: typeof result?.model === 'string' ? result.model : model, inputTokens: tokensOf(result?.prompt_eval_count) };
    } catch (cause) {
      if (req.signal.aborted) throw new EngineError('CANCELLED', 'Embedding request cancelled', { cause });
      if (cause instanceof EngineError) throw cause;
      throw new EngineError('PROVIDER', 'Invalid Ollama embedding response', { cause });
    }
  }
}

function toOllamaMessage(m: LLMMessage): Record<string, unknown> {
  const images = m.images?.map((url) => url.replace(/^data:[^;]+;base64,/, ''));
  return {
    role: m.role, content: m.content,
    ...(images?.length ? { images } : {}),
    ...(m.role === 'tool' && m.name ? { tool_name: m.name } : {}),
    ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) } : {}),
  };
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is { function: { name: string; arguments?: unknown } } => typeof c?.function?.name === 'string')
    .map((c, i) => ({ id: `call_${i}`, name: c.function.name, arguments: parseToolArguments(c.function.arguments) }));
}
