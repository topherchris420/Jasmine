import { EngineError } from '../errors.ts';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema of the tool arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  /** For `tool` messages: the call this result answers. */
  toolCallId?: string;
  /** For `tool` messages: the tool name. */
  name?: string;
  /** Data URLs (`data:image/png;base64,...`) for vision-capable local models. */
  images?: string[];
}

export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  /** JSON schema the response must satisfy (structured output). */
  jsonSchema?: Record<string, unknown>;
  tools?: ToolSpec[];
  /** How much a reasoning model thinks; unset leaves it to the model. Other models ignore it. */
  thinking?: 'off' | 'low' | 'medium' | 'high';
  signal: AbortSignal;
  /** Called with each streamed text delta when the provider streams. */
  onToken?: (delta: string) => void;
  /** Called with each streamed delta of a reasoning model's thinking, which is never part of `text`. */
  onReasoning?: (delta: string) => void;
}

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  /** A reasoning model's thinking, kept apart from the answer. */
  reasoning?: string;
}

export interface EmbedRequest {
  model: string;
  input: string[];
  signal: AbortSignal;
}

export interface EmbedResponse {
  vectors: number[][];
  model: string;
  inputTokens: number;
}

export interface ModelInfo {
  id: string;
  kind: 'chat' | 'embedding';
  sizeBytes?: number;
  family?: string;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  size: string;
  signal: AbortSignal;
}

export interface LLMProvider {
  readonly name: string;
  generate(req: LLMRequest): Promise<LLMResponse>;
  embed?(req: EmbedRequest): Promise<EmbedResponse>;
  listModels?(signal: AbortSignal): Promise<ModelInfo[]>;
  /** Text-to-image; returns a data URL. */
  generateImage?(req: ImageRequest): Promise<{ url: string }>;
}

export const EMBEDDING_NAME = /embed|bge|e5-|gte-|minilm|nomic-bert|arctic-embed|mxbai/i;

export function guessModelKind(id: string, family?: string): ModelInfo['kind'] {
  return EMBEDDING_NAME.test(id) || (family !== undefined && /bert/i.test(family)) ? 'embedding' : 'chat';
}

export function httpError(service: string, status: number): EngineError {
  return new EngineError(status === 429 ? 'RATE_LIMITED' : 'PROVIDER', `${service} returned HTTP ${status}`, {
    retryable: status === 429 || status === 408 || status >= 500,
    details: { status },
  });
}

/** A request stopped by its signal: a time limit reports TIMEOUT (retryable), anything else CANCELLED. */
export function abortedError(signal: AbortSignal, service: string, cause: unknown): EngineError {
  const reason = signal.reason as { name?: unknown } | undefined;
  if (reason?.name === 'TimeoutError') return new EngineError('TIMEOUT', `${service[0]!.toUpperCase()}${service.slice(1)} did not answer within the time limit`, { retryable: true, cause });
  return new EngineError('CANCELLED', `Request to ${service} was cancelled`, { cause });
}

/**
 * Output budget when a step sets none. Reasoning models often think for over a thousand tokens before a
 * one-sentence answer, so a smaller default fails them on ordinary requests.
 */
export const DEFAULT_MAX_TOKENS = 4096;

/** A reply stopped by its token limit; says so plainly when the model spent the whole budget thinking. */
export function tokenLimitError(answer: string, reasoning: string): EngineError {
  if (reasoning && !answer.trim()) {
    return new EngineError('PROVIDER', `The model used its whole token limit thinking (${reasoning.length} characters of reasoning) and wrote no answer; set Thinking to Off in the step's advanced settings, or raise its max output tokens`, { details: { thinkingBudget: true } });
  }
  return new EngineError('PROVIDER', 'Local model response exceeded its token limit; raise maxTokens or shorten the prompt');
}

const THINK_TAGS: [open: string, close: string][] = [['<think>', '</think>'], ['<thinking>', '</thinking>']];

/**
 * Separates a reasoning model's thinking from its answer when both arrive in the reply text, as
 * `<think>…</think>` (llama.cpp, vLLM and Ollama's /v1 without a reasoning parser). Chat templates that
 * open the tag in the prompt (DeepSeek-R1, Qwen3 thinking) emit only the closing tag; the text before it is
 * then reclassified as reasoning, although any tokens already streamed cannot be taken back.
 */
export class ThinkingFilter {
  answer = '';
  reasoning = '';
  private state: 'start' | 'thinking' | 'after' | 'answer' = 'start';
  private close = '';
  private pending = '';
  private opened = false;
  private readonly onAnswer: ((delta: string) => void) | undefined;
  private readonly onReasoning: ((delta: string) => void) | undefined;

  constructor(onAnswer?: (delta: string) => void, onReasoning?: (delta: string) => void) {
    this.onAnswer = onAnswer;
    this.onReasoning = onReasoning;
  }

  push(delta: string): void {
    this.pending += delta;
    for (;;) {
      if (this.state === 'start') {
        const head = this.pending.trimStart();
        if (!head || THINK_TAGS.some(([open]) => open.startsWith(head) && open !== head)) return;
        const tag = THINK_TAGS.find(([open]) => head.startsWith(open));
        if (!tag) {
          this.state = 'answer';
          continue;
        }
        [, this.close] = tag;
        this.opened = true;
        this.state = 'thinking';
        this.pending = head.slice(tag[0].length);
      } else if (this.state === 'thinking') {
        const end = this.pending.indexOf(this.close);
        if (end < 0) {
          // Hold back a possible partial closing tag split across chunks.
          let keep = Math.min(this.close.length - 1, this.pending.length);
          while (keep > 0 && !this.close.startsWith(this.pending.slice(-keep))) keep--;
          this.think(this.pending.slice(0, this.pending.length - keep));
          this.pending = this.pending.slice(this.pending.length - keep);
          return;
        }
        this.think(this.pending.slice(0, end));
        this.pending = this.pending.slice(end + this.close.length);
        this.state = 'after';
      } else if (this.state === 'after') {
        const rest = this.pending.trimStart();
        this.pending = '';
        if (!rest) return;
        this.state = 'answer';
        this.say(rest);
        return;
      } else {
        const text = this.pending;
        this.pending = '';
        this.say(text);
        return;
      }
    }
  }

  /** Flushes held-back text once the reply is complete. */
  end(): void {
    if (this.state === 'thinking') this.think(this.pending);
    else if (this.state !== 'after') this.say(this.pending);
    this.pending = '';
  }

  private think(text: string): void {
    if (!text) return;
    this.reasoning += text;
    this.onReasoning?.(text);
  }

  private say(text: string): void {
    if (!text) return;
    this.answer += text;
    this.onAnswer?.(text);
    if (this.opened) return;
    for (const [open, close] of THINK_TAGS) {
      const orphan = this.answer.indexOf(close, Math.max(0, this.answer.length - text.length - close.length + 1));
      if (orphan < 0 || this.answer.slice(0, orphan).includes(open)) continue;
      this.opened = true;
      const thought = this.answer.slice(0, orphan);
      this.answer = this.answer.slice(orphan + close.length).trimStart();
      // Nothing after the tag yet: trim the start of the next chunk, as after a regular closing tag.
      if (!this.answer) this.state = 'after';
      this.think(thought);
      return;
    }
  }
}

/** Splits a complete reply into its answer and any inline thinking. */
export function splitThinking(text: string): { answer: string; reasoning: string } {
  const filter = new ThinkingFilter();
  filter.push(text);
  filter.end();
  return { answer: filter.answer, reasoning: filter.reasoning };
}

/**
 * A reasoning model that thought and then stopped without an answer. Downstream steps would otherwise receive a blank
 * reply as a success. Retrying can help, since the model may answer the next time.
 */
export const onlyThinkingError = () =>
  new EngineError('PROVIDER', 'The model returned only its thinking and no answer', { retryable: true, details: { onlyThinking: true } });

/** Key for a refused Thinking setting: a server can accept some levels for a model and refuse others (o-series models have no "none"). */
export const thinkingKey = (model: string, thinking: string) => `${model}\u0000${thinking}`;

/** Whether a provider error carries the given `details` flag (a server refused an optional request feature). */
export const detailOf = (error: unknown, flag: string): boolean =>
  error instanceof EngineError && (error.details as Record<string, unknown> | undefined)?.[flag] === true;

export function tokensOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Rough token estimate (~4 characters per token) for providers that omit usage. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function validateBaseUrl(raw: string, setting: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EngineError('PROVIDER', `${setting} is not a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new EngineError('PROVIDER', `${setting} must be an HTTP(S) API base URL without credentials, query, or fragment`);
  }
  return url.href.replace(/\/+$/, '');
}

/** Parses a tool-call argument payload that may be a JSON string, an object, or garbage. */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return { _raw: raw };
    }
  }
  return {};
}

/** Reads a streamed response body line by line. */
export async function* readLines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line) yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.trim();
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
