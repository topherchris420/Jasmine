import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JasmineDb } from '../db/database.ts';
import { parseJson } from '../db/database.ts';
import type { SecretBox } from '../db/secrets.ts';
import { EngineError, toEngineError } from '../errors.ts';
import { BuiltinEmbeddingProvider, LEXICAL_MODEL, MockLLMProvider } from '../llm/mock.ts';
import { OllamaProvider } from '../llm/ollama.ts';
import { OpenAICompatibleProvider } from '../llm/openai.ts';
import type { ConnectionHandle, ModelRouter } from '../llm/router.ts';
import type { LLMProvider, ModelInfo } from '../llm/types.ts';
import type { SettingsStore } from './settings.ts';

export const CONNECTION_KINDS = ['ollama', 'openai', 'mock', 'builtin'] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export interface ModelConnection {
  id: string;
  name: string;
  kind: ConnectionKind;
  baseUrl: string | null;
  hasApiKey: boolean;
  chatModel: string | null;
  embeddingModel: string | null;
  aliases: Record<string, string>;
  defaultChat: boolean;
  defaultEmbedding: boolean;
  createdAt: string;
  updatedAt: string;
}

export const ConnectionInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'id must be lowercase letters, digits, - or _').optional(),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(CONNECTION_KINDS),
  baseUrl: z.string().trim().max(500).nullish(),
  /** undefined keeps the stored key, '' clears it. */
  apiKey: z.string().max(4000).optional(),
  chatModel: z.string().trim().max(200).nullish(),
  embeddingModel: z.string().trim().max(200).nullish(),
  aliases: z.record(z.string().max(200), z.string().max(200)).optional(),
});
export type ConnectionInput = z.input<typeof ConnectionInputSchema>;

interface Row {
  id: string; name: string; kind: string; base_url: string | null; api_key: string | null;
  chat_model: string | null; embedding_model: string | null; aliases: string; created_at: string; updated_at: string;
}

export const DEFAULT_BASE_URLS: Record<ConnectionKind, string | null> = {
  ollama: 'http://127.0.0.1:11434',
  openai: 'http://127.0.0.1:1234/v1',
  mock: null,
  builtin: null,
};

export interface ConnectionServiceOptions {
  fetch?: typeof globalThis.fetch;
  structuredOutput?: 'json_schema' | 'json_object';
  mockLatencyMs?: number;
}

/** Model connections: local inference servers Jasmine can route chat and embedding calls to. */
export class ConnectionService {
  private readonly db: JasmineDb;
  private readonly secrets: SecretBox;
  private readonly settings: SettingsStore;
  readonly router: ModelRouter;
  private readonly opts: ConnectionServiceOptions;

  constructor(db: JasmineDb, secrets: SecretBox, settings: SettingsStore, router: ModelRouter, opts: ConnectionServiceOptions = {}) {
    this.db = db;
    this.secrets = secrets;
    this.settings = settings;
    this.router = router;
    this.opts = opts;
    this.ensureBuiltin();
    this.rebuild();
  }

  list(): ModelConnection[] {
    const defaults = this.defaults();
    return this.db.all<Row>('SELECT * FROM model_connections ORDER BY created_at, id').map((r) => this.view(r, defaults));
  }

  get(id: string): ModelConnection | undefined {
    const row = this.db.get<Row>('SELECT * FROM model_connections WHERE id = ?', id);
    return row ? this.view(row, this.defaults()) : undefined;
  }

  upsert(input: ConnectionInput): ModelConnection {
    const parsed = ConnectionInputSchema.safeParse(input);
    if (!parsed.success) throw new EngineError('BAD_PAYLOAD', `Invalid connection: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    const value = parsed.data;
    const id = value.id ?? slug(value.name);
    const existing = this.db.get<Row>('SELECT * FROM model_connections WHERE id = ?', id);
    if (id === 'builtin' && (value.kind !== 'builtin' || existing === undefined)) throw new EngineError('CONFLICT', 'The built-in connection id is reserved');
    if (value.kind === 'builtin' && id !== 'builtin') throw new EngineError('BAD_PAYLOAD', 'Only one built-in connection exists');
    const baseUrl = value.kind === 'ollama' || value.kind === 'openai' ? (value.baseUrl || DEFAULT_BASE_URLS[value.kind]) : null;
    // Constructing the provider validates the URL before anything is stored.
    this.createProvider({ kind: value.kind, base_url: baseUrl, api_key: null, id, name: value.name });
    const apiKey = value.apiKey === undefined ? existing?.api_key ?? null : value.apiKey === '' ? null : this.secrets.seal(value.apiKey);
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO model_connections (id, name, kind, base_url, api_key, chat_model, embedding_model, aliases, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, base_url = excluded.base_url, api_key = excluded.api_key,
         chat_model = excluded.chat_model, embedding_model = excluded.embedding_model, aliases = excluded.aliases, updated_at = excluded.updated_at`,
      id, value.name, value.kind, baseUrl, apiKey, value.chatModel || null,
      value.kind === 'builtin' ? LEXICAL_MODEL : value.embeddingModel || null,
      JSON.stringify(value.aliases ?? parseJson(existing?.aliases, {})), existing?.created_at ?? now, now,
    );
    this.rebuild();
    return this.get(id)!;
  }

  remove(id: string): boolean {
    if (id === 'builtin') throw new EngineError('CONFLICT', 'The built-in connection cannot be removed');
    const removed = Number(this.db.run('DELETE FROM model_connections WHERE id = ?', id).changes) > 0;
    const defaults = this.defaults();
    if (defaults.chat === id || defaults.embedding === id) {
      this.settings.set('models.defaults', { chat: defaults.chat === id ? null : defaults.chat, embedding: defaults.embedding === id ? null : defaults.embedding });
    }
    this.rebuild();
    return removed;
  }

  setDefaults(defaults: { chat?: string | null; embedding?: string | null }): void {
    const current = this.defaults();
    for (const id of [defaults.chat, defaults.embedding]) {
      if (id && !this.get(id)) throw new EngineError('NOT_FOUND', `Connection ${id} not found`);
    }
    if (defaults.chat && this.get(defaults.chat)?.kind === 'builtin') throw new EngineError('BAD_PAYLOAD', 'The built-in connection cannot generate text');
    this.settings.set('models.defaults', {
      chat: defaults.chat === undefined ? current.chat : defaults.chat,
      embedding: defaults.embedding === undefined ? current.embedding : defaults.embedding,
    });
    this.rebuild();
  }

  defaults(): { chat: string | null; embedding: string | null } {
    return this.settings.get('models.defaults', { chat: null as string | null, embedding: null as string | null });
  }

  /** Lists models and reports reachability without throwing. */
  async test(id: string): Promise<{ ok: boolean; latencyMs: number; models: ModelInfo[]; error?: string }> {
    const conn = this.router.get(id);
    if (!conn) throw new EngineError('NOT_FOUND', `Connection ${id} not found`);
    const t0 = performance.now();
    try {
      const models = conn.provider.listModels ? await conn.provider.listModels(AbortSignal.timeout(10_000)) : [];
      return { ok: true, latencyMs: Math.round(performance.now() - t0), models };
    } catch (e) {
      return { ok: false, latencyMs: Math.round(performance.now() - t0), models: [], error: toEngineError(e).message };
    }
  }

  /** First boot: one connection from the environment, plus anything reachable on the usual local ports. */
  async bootstrap(env: Record<string, string | undefined>, probe = true): Promise<void> {
    const count = this.db.get<{ n: number }>("SELECT count(*) AS n FROM model_connections WHERE kind != 'builtin'")!.n;
    if (count > 0) return;
    const provider = (env['LLM_PROVIDER'] ?? '').toLowerCase();
    const kind: ConnectionKind | undefined = provider === 'ollama' ? 'ollama'
      : provider === 'mock' ? 'mock'
      : ['openai', 'local', 'lmstudio', 'openai-compatible'].includes(provider) ? 'openai'
      : undefined;
    const seeds: ConnectionInput[] = [];
    if (kind) {
      seeds.push({
        id: kind === 'openai' ? 'local' : kind, name: kind === 'ollama' ? 'Ollama' : kind === 'mock' ? 'Mock (deterministic)' : 'Local OpenAI-compatible server', kind,
        ...(env['LLM_BASE_URL'] ? { baseUrl: env['LLM_BASE_URL'] } : {}),
        ...(env['LLM_API_KEY'] ? { apiKey: env['LLM_API_KEY'] } : {}),
        ...(env['LLM_MODEL'] ? { chatModel: env['LLM_MODEL'] } : {}),
        ...(env['EMBEDDING_MODEL'] ? { embeddingModel: env['EMBEDDING_MODEL'] } : {}),
      });
    } else {
      const candidates: ConnectionInput[] = [
        { id: 'ollama', name: 'Ollama', kind: 'ollama' },
        { id: 'lmstudio', name: 'LM Studio', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' },
      ];
      const reachable = probe ? await Promise.all(candidates.map(async (c) => {
        const url = c.kind === 'ollama' ? `${DEFAULT_BASE_URLS.ollama}/api/version` : `${c.baseUrl}/models`;
        try {
          const res = await (this.opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(1500) });
          await res.body?.cancel();
          return res.ok;
        } catch {
          return false;
        }
      })) : candidates.map(() => false);
      const found = candidates.filter((_, i) => reachable[i]);
      seeds.push(...(found.length ? found : [candidates[0]!]));
    }
    for (const seed of seeds) this.upsert(seed);
    const first = seeds[0]!;
    const firstId = first.id ?? slug(first.name);
    this.setDefaults({ chat: firstId, embedding: first.kind === 'mock' ? firstId : this.defaults().embedding });
  }

  rebuild(): void {
    const rows = this.db.all<Row>('SELECT * FROM model_connections ORDER BY created_at, id');
    const handles: ConnectionHandle[] = rows.map((r) => ({
      id: r.id, name: r.name, kind: r.kind, provider: this.createProvider(r),
      chatModel: r.chat_model ?? undefined, embeddingModel: r.embedding_model ?? undefined, aliases: parseJson(r.aliases, {}),
    }));
    const defaults = this.defaults();
    this.router.setConnections(handles, { defaultChat: defaults.chat ?? undefined, defaultEmbedding: defaults.embedding ?? undefined });
  }

  private createProvider(row: Pick<Row, 'id' | 'name' | 'kind' | 'base_url' | 'api_key'>): LLMProvider {
    const apiKey = row.api_key ? this.secrets.open(row.api_key) : undefined;
    const common = { name: row.id, ...(apiKey ? { apiKey } : {}), ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}) };
    switch (row.kind) {
      case 'ollama': return new OllamaProvider({ ...common, baseURL: row.base_url ?? DEFAULT_BASE_URLS.ollama! });
      case 'openai': return new OpenAICompatibleProvider({ ...common, baseURL: row.base_url ?? DEFAULT_BASE_URLS.openai!, ...(this.opts.structuredOutput ? { structuredOutput: this.opts.structuredOutput } : {}) });
      case 'mock': return new MockLLMProvider({ name: row.id, latencyMs: this.opts.mockLatencyMs ?? 0 });
      case 'builtin': return new BuiltinEmbeddingProvider();
      default: throw new EngineError('BAD_PAYLOAD', `Unknown connection kind ${row.kind}`);
    }
  }

  private ensureBuiltin(): void {
    if (this.db.get('SELECT 1 FROM model_connections WHERE id = ?', 'builtin')) return;
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO model_connections (id, name, kind, embedding_model, aliases, created_at, updated_at) VALUES ('builtin', 'Built-in lexical embeddings', 'builtin', ?, '{}', ?, ?)`,
      LEXICAL_MODEL, now, now,
    );
  }

  private view(r: Row, defaults: { chat: string | null; embedding: string | null }): ModelConnection {
    return {
      id: r.id, name: r.name, kind: r.kind as ConnectionKind, baseUrl: r.base_url, hasApiKey: !!r.api_key,
      chatModel: r.chat_model, embeddingModel: r.embedding_model, aliases: parseJson(r.aliases, {}),
      defaultChat: defaults.chat === r.id, defaultEmbedding: defaults.embedding === r.id,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
}

export function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return s || `conn-${randomUUID().slice(0, 8)}`;
}
