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
  signal: AbortSignal;
  /** Called with each streamed text delta when the provider streams. */
  onToken?: (delta: string) => void;
}

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
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
