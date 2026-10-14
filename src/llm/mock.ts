import { setTimeout as sleep } from 'node:timers/promises';
import { EngineError } from '../errors.ts';
import type { EmbedRequest, EmbedResponse, LLMProvider, LLMRequest, LLMResponse, ModelInfo, ToolCall } from './types.ts';

export interface MockReply {
  text?: string;
  toolCalls?: ToolCall[];
}

export interface MockLLMOptions {
  latencyMs?: number | ((req: LLMRequest, call: number) => number);
  respond?: (req: LLMRequest, call: number) => string | MockReply;
  /** Return an error to fail this call (fault injection). */
  fail?: (req: LLMRequest, call: number) => EngineError | undefined;
  name?: string;
  embeddingDimensions?: number;
}

/** Deterministic provider for tests, demos and benchmarks; honours cancellation like a real network call. */
export class MockLLMProvider implements LLMProvider {
  readonly name: string;
  calls = 0;
  embedCalls = 0;
  readonly requests: LLMRequest[] = [];
  private readonly opts: MockLLMOptions;

  constructor(opts: MockLLMOptions = {}) {
    this.opts = opts;
    this.name = opts.name ?? 'mock';
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const call = ++this.calls;
    this.requests.push(req);
    const latency = typeof this.opts.latencyMs === 'function' ? this.opts.latencyMs(req, call) : (this.opts.latencyMs ?? 0);
    if (latency > 0) await sleep(latency, undefined, { signal: req.signal });
    else req.signal.throwIfAborted();
    const failure = this.opts.fail?.(req, call);
    if (failure) throw failure;
    const prompt = req.messages.map((m) => m.content).join('\n');
    const reply = this.opts.respond?.(req, call);
    const text = typeof reply === 'string' ? reply : reply?.text ?? (reply?.toolCalls ? '' : req.jsonSchema ? '{}' : `echo:${prompt}`);
    if (req.onToken && text) for (const piece of text.match(/\S+\s*|\s+/g) ?? []) req.onToken(piece);
    return {
      text, inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(text.length / 4), model: req.model,
      ...(typeof reply === 'object' && reply.toolCalls?.length ? { toolCalls: reply.toolCalls } : {}),
    };
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls++;
    req.signal.throwIfAborted();
    const dims = this.opts.embeddingDimensions ?? LEXICAL_DIMENSIONS;
    return { vectors: req.input.map((t) => lexicalEmbedding(t, dims)), model: req.model, inputTokens: req.input.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'mock-model', kind: 'chat' }, { id: 'mock-embedding', kind: 'embedding' }];
  }
}

export const LEXICAL_MODEL = 'jasmine-lexical-384';
export const LEXICAL_DIMENSIONS = 384;

/**
 * Embeddings without a model server: a signed feature-hashing of words and character trigrams.
 * It captures lexical overlap, not meaning; use a real local embedding model for semantic search.
 */
export class BuiltinEmbeddingProvider implements LLMProvider {
  readonly name = 'builtin';

  async generate(): Promise<LLMResponse> {
    throw new EngineError('PROVIDER', 'The built-in connection only provides embeddings; choose a local model connection for text generation');
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    req.signal.throwIfAborted();
    return { vectors: req.input.map((t) => lexicalEmbedding(t)), model: LEXICAL_MODEL, inputTokens: req.input.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: LEXICAL_MODEL, kind: 'embedding' }];
  }
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function lexicalEmbedding(text: string, dims = LEXICAL_DIMENSIONS): number[] {
  const v = new Float64Array(dims);
  const counts = new Map<string, number>();
  for (const word of tokenize(text)) {
    counts.set(`w:${word}`, (counts.get(`w:${word}`) ?? 0) + 1);
    const padded = `#${word}#`;
    for (let i = 0; i + 3 <= padded.length; i++) counts.set(`g:${padded.slice(i, i + 3)}`, (counts.get(`g:${padded.slice(i, i + 3)}`) ?? 0) + 0.25);
  }
  for (const [feature, count] of counts) {
    const h = fnv1a(feature);
    v[h % dims]! += (h & 0x80000000 ? -1 : 1) * (1 + Math.log(1 + count));
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => x / norm);
}
