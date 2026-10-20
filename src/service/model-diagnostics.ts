import type { Jasmine } from '../app.ts';
import { EngineError, toEngineError } from '../errors.ts';
import type { ModelInfo } from '../llm/types.ts';
import { isLoopback } from './readiness.ts';

/**
 * Connection troubleshooting that runs on the Jasmine runtime, because that is where model requests come from.
 * Nothing here is saved; a diagnosis reports what the runtime saw and what to try next.
 */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';
export interface DiagnosisCheck { id: 'url' | 'reach' | 'auth' | 'api' | 'chat' | 'embedding'; label: string; status: CheckStatus; detail: string }
export interface DiagnosedModel extends ModelInfo { capabilities: ('chat' | 'embedding' | 'vision')[] }

export interface Diagnosis {
  ok: boolean;
  kind: 'ollama' | 'openai';
  baseUrl: string;
  location: { id: 'runtime' | 'private-network' | 'internet'; label: string; detail: string };
  latencyMs: number | null;
  checks: DiagnosisCheck[];
  models: DiagnosedModel[];
  capabilities: { chat: boolean; embedding: boolean; vision: boolean };
  suggested: { chatModel: string | null; embeddingModel: string | null };
  hints: { title: string; steps: string[] }[];
}

export interface DiscoveredServer {
  id: string;
  label: string;
  kind: 'ollama' | 'openai';
  baseUrl: string;
  ok: boolean;
  models: DiagnosedModel[];
  connectionId: string | null;
}

const VISION = /llava|vision|[-_.]vl\b|vl[:-]|minicpm-v|gemma3|moondream|pixtral|qwen2\.5vl|granite3\.2-vision/i;
const PREFERRED_EMBEDDING = /nomic-embed|mxbai-embed|bge-|e5-|gte-|arctic-embed|all-minilm/i;

const CANDIDATES: Omit<DiscoveredServer, 'ok' | 'models' | 'connectionId'>[] = [
  { id: 'ollama-local', label: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
  { id: 'lmstudio-local', label: 'LM Studio', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'llamacpp-local', label: 'llama.cpp / LocalAI', kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'vllm-local', label: 'vLLM', kind: 'openai', baseUrl: 'http://127.0.0.1:8000/v1' },
  { id: 'ollama-compose', label: 'Ollama (Docker Compose service)', kind: 'ollama', baseUrl: 'http://ollama:11434' },
  { id: 'ollama-docker-host', label: 'Ollama on the Docker host', kind: 'ollama', baseUrl: 'http://host.docker.internal:11434' },
];

function classify(models: ModelInfo[]): DiagnosedModel[] {
  return models.map((m) => ({ ...m, capabilities: m.kind === 'embedding' ? ['embedding'] : VISION.test(m.id) ? ['chat', 'vision'] : ['chat'] }));
}

export function locate(baseUrl: string, hosted: boolean): Diagnosis['location'] {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    /* reported by the URL check */
  }
  if (isLoopback(baseUrl)) {
    return { id: 'runtime', label: 'The Jasmine runtime’s own machine', detail: hosted
      ? 'Jasmine is hosted, so this address is the runtime server, not your computer. A model server on your laptop is not reachable here.'
      : 'Jasmine and the model server run on the same machine. This works when you start Jasmine locally.' };
  }
  const privateHost = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) || (host.includes(':') && /^f[cd]/i.test(host)) || host === 'host.docker.internal' || host.endsWith('.local') || host.endsWith('.internal') || (!!host && !host.includes('.') && !host.includes(':'));
  if (privateHost) return { id: 'private-network', label: 'A machine on the runtime’s private network', detail: 'The runtime must be able to reach this address, for example over your LAN, a VPN or a Docker network.' };
  return { id: 'internet', label: 'A server on the internet', detail: baseUrl.startsWith('https://') ? 'Requests and any API key travel over HTTPS to this provider.' : 'This address is not HTTPS, so prompts and any API key would travel unencrypted. Use HTTPS for remote servers.' };
}

function reachHints(kind: Diagnosis['kind'], baseUrl: string, hosted: boolean, loopback: boolean): Diagnosis['hints'] {
  const hints: Diagnosis['hints'] = [];
  if (hosted && loopback) {
    hints.push({ title: 'Your runtime is hosted', steps: [
      'Run the model server on the same host or private network as the Jasmine runtime, then use that address.',
      'Or use a hosted OpenAI-compatible provider that the runtime can reach over HTTPS.',
      'Avoid exposing an unauthenticated model server to the internet.',
    ] });
  }
  if (kind === 'ollama') {
    hints.push({ title: 'Start Ollama', steps: [
      'Open the Ollama app, or run “ollama serve” in a terminal.',
      `Check it answers: open ${baseUrl.replace(/\/+$/, '')}/api/version on the runtime’s machine.`,
      'If Jasmine runs in Docker, use http://host.docker.internal:11434 (Docker Desktop) or the Compose service address http://ollama:11434.',
      'If Ollama runs on another machine, start it with OLLAMA_HOST=0.0.0.0 so it accepts network connections.',
    ] });
  } else {
    hints.push({ title: 'Start your OpenAI-compatible server', steps: [
      'LM Studio: open the Developer tab, load a model and press Start Server (default port 1234).',
      'llama.cpp: start llama-server with --host and --port; vLLM: run “vllm serve <model>”.',
      'The address must include the /v1 path, for example http://127.0.0.1:1234/v1.',
      'If the server runs on another machine, allow network access (LM Studio: “Serve on Local Network”).',
    ] });
  }
  return hints;
}

export class ModelDiagnostics {
  private readonly app: Jasmine;
  constructor(app: Jasmine) {
    this.app = app;
  }

  private get hosted(): boolean {
    const env = this.app.config.env ?? {};
    return !!env['JASMINE_GATEWAY_SECRET'] || (env['PUBLIC_URL'] ?? '').startsWith('https://');
  }

  /** Diagnoses a saved connection (using its stored key) or an unsaved address. */
  async diagnose(input: { connectionId?: unknown; kind?: unknown; baseUrl?: unknown; apiKey?: unknown; timeoutMs?: unknown }): Promise<Diagnosis> {
    let kind: Diagnosis['kind'];
    let baseUrl: string;
    let listing: { ok: boolean; latencyMs: number; models: ModelInfo[]; error?: unknown };
    const timeoutMs = typeof input.timeoutMs === 'number' && input.timeoutMs >= 500 && input.timeoutMs <= 30_000 ? input.timeoutMs : 8000;
    if (typeof input.connectionId === 'string' && input.connectionId) {
      const conn = this.app.connections.get(input.connectionId);
      if (!conn) throw new EngineError('NOT_FOUND', 'Connection not found');
      if (conn.kind !== 'ollama' && conn.kind !== 'openai') throw new EngineError('BAD_PAYLOAD', 'Only model server connections can be diagnosed');
      kind = conn.kind;
      baseUrl = conn.baseUrl ?? '';
      listing = await this.app.connections.probeSaved(conn.id, timeoutMs);
    } else {
      if (input.kind !== 'ollama' && input.kind !== 'openai') throw new EngineError('BAD_PAYLOAD', 'kind must be "ollama" or "openai"');
      kind = input.kind;
      baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : kind === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234/v1';
      listing = await this.app.connections.probe({ kind, baseUrl, ...(typeof input.apiKey === 'string' && input.apiKey ? { apiKey: input.apiKey } : {}) }, timeoutMs);
    }
    return this.report(kind, baseUrl, listing);
  }

  private report(kind: Diagnosis['kind'], baseUrl: string, listing: { ok: boolean; latencyMs: number; models: ModelInfo[]; error?: unknown }): Diagnosis {
    const hosted = this.hosted;
    const loopback = isLoopback(baseUrl);
    const checks: DiagnosisCheck[] = [];
    const hints: Diagnosis['hints'] = [];
    const models = classify(listing.models);
    const add = (id: DiagnosisCheck['id'], label: string, status: CheckStatus, detail: string) => checks.push({ id, label, status, detail });
    const error = listing.ok ? undefined : toEngineError(listing.error);
    const status = (error?.details as { status?: number } | undefined)?.status;
    const message = error?.message ?? '';

    if (error && /not a valid URL|must be an HTTP\(S\)/.test(message)) {
      add('url', 'Address is valid', 'fail', message);
      hints.push({ title: 'Fix the address', steps: [kind === 'ollama' ? 'Use the server root, for example http://127.0.0.1:11434.' : 'Use the API base including /v1, for example http://127.0.0.1:1234/v1.', 'Do not include usernames, passwords, query strings or fragments.'] });
    } else {
      add('url', 'Address is valid', 'pass', baseUrl);
      if (!error) {
        add('reach', 'Server responds', 'pass', `Answered in ${listing.latencyMs} ms.`);
        add('auth', 'Access allowed', 'pass', 'The server accepted the request.');
        add('api', 'Speaks the expected API', 'pass', kind === 'ollama' ? 'Ollama’s /api/tags listing worked.' : 'The /models listing worked.');
      } else if (error.code === 'NETWORK') {
        add('reach', 'Server responds', 'fail', `Nothing answered at ${baseUrl}. The server is not running, the port is wrong, or the runtime cannot reach that machine.`);
        hints.push(...reachHints(kind, baseUrl, hosted, loopback));
      } else if (error.code === 'TIMEOUT') {
        add('reach', 'Server responds', 'fail', 'The server did not answer in time. A firewall may be dropping the connection, or the server is busy loading a model.');
        hints.push({ title: 'Check the network path', steps: ['Confirm the host and port are correct and reachable from the runtime’s machine.', 'If the server is loading a large model, wait a moment and test again.'] }, ...(hosted && loopback ? reachHints(kind, baseUrl, hosted, loopback).slice(0, 1) : []));
      } else if (status === 401 || status === 403) {
        add('reach', 'Server responds', 'pass', 'The server answered.');
        add('auth', 'Access allowed', 'fail', `The server refused the request (HTTP ${status}).`);
        hints.push({ title: 'Check the API key', steps: ['Paste the key your provider issued for this server.', 'Keys are encrypted on the runtime and never shown in the browser again.'] });
      } else if (status === 404) {
        add('reach', 'Server responds', 'pass', 'The server answered.');
        add('api', 'Speaks the expected API', 'fail', `The model listing was not found at this address (HTTP 404).`);
        hints.push({ title: 'Check the path', steps: kind === 'openai'
          ? ['OpenAI-compatible addresses usually end in /v1, for example http://127.0.0.1:1234/v1.', 'If this is an Ollama server, choose Ollama as the connection type.']
          : ['Use the Ollama server root without /api or /v1, for example http://127.0.0.1:11434.', 'If this is LM Studio or another OpenAI-compatible server, choose that connection type.'] });
      } else if (/invalid JSON/i.test(message)) {
        add('reach', 'Server responds', 'pass', 'Something answered at this address.');
        add('api', 'Speaks the expected API', 'fail', 'The reply was not a model API response; this port may serve a web page or another service.');
        hints.push({ title: 'Check the port', steps: ['Ollama uses port 11434; LM Studio uses 1234 by default.', 'Make sure the address points at the model server’s API.'] });
      } else {
        add('reach', 'Server responds', status ? 'pass' : 'fail', message || 'The request failed.');
        if (status && status >= 500) hints.push({ title: 'The server reported an error', steps: ['Check the model server’s own logs.', 'Restart it and test again.'] });
      }
    }

    const chat = models.filter((m) => m.kind === 'chat');
    const embedding = models.filter((m) => m.kind === 'embedding');
    if (error) {
      add('chat', 'Chat model available', 'skip', 'Checked once the server responds.');
      add('embedding', 'Embedding model available', 'skip', 'Checked once the server responds.');
    } else {
      add('chat', 'Chat model available', chat.length ? 'pass' : 'fail', chat.length ? `${chat.length} chat model(s): ${chat.slice(0, 5).map((m) => m.id).join(', ')}` : 'The server lists no chat model.');
      add('embedding', 'Embedding model available', embedding.length ? 'pass' : 'warn', embedding.length ? `${embedding.map((m) => m.id).slice(0, 4).join(', ')}` : 'Needed only to search documents by meaning. Built-in keyword embeddings work without one.');
      if (!chat.length) hints.push({ title: 'Install a chat model', steps: kind === 'ollama' ? ['Run “ollama pull llama3.2” (about 2 GB) or another model that fits your hardware.', 'Then test the connection again.'] : ['Download and load a chat model in your server (LM Studio: Discover tab).', 'Then test the connection again.'] });
      if (!embedding.length) hints.push({ title: 'Optional: add an embedding model for document search', steps: kind === 'ollama' ? ['Run “ollama pull nomic-embed-text” (about 270 MB).'] : ['Load an embedding model such as nomic-embed-text in your server.'] });
    }
    const vision = chat.some((m) => m.capabilities.includes('vision'));
    return {
      ok: !error && chat.length > 0,
      kind, baseUrl, location: locate(baseUrl, hosted), latencyMs: error ? null : listing.latencyMs, checks, models,
      capabilities: { chat: chat.length > 0, embedding: embedding.length > 0, vision },
      suggested: { chatModel: chat[0]?.id ?? null, embeddingModel: (embedding.find((m) => PREFERRED_EMBEDDING.test(m.id)) ?? embedding[0])?.id ?? null },
      hints,
    };
  }

  /** Looks for model servers on the usual local ports and Docker addresses, as seen from the runtime. */
  async discover(timeoutMs = 1500): Promise<{ hosted: boolean; servers: DiscoveredServer[] }> {
    const saved = this.app.connections.list();
    const servers = await Promise.all(CANDIDATES.map(async (c) => {
      const listing = await this.app.connections.probe({ kind: c.kind, baseUrl: c.baseUrl }, timeoutMs);
      const normalized = c.baseUrl.replace(/\/+$/, '');
      const existing = saved.find((s) => s.kind === c.kind && (s.baseUrl ?? '').replace(/\/+$/, '') === normalized);
      return { ...c, ok: listing.ok, models: classify(listing.models), connectionId: existing?.id ?? null };
    }));
    return { hosted: this.hosted, servers };
  }
}
