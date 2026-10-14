import { EngineError } from '../errors.ts';
import type { EmbedResponse, LLMProvider, LLMRequest, LLMResponse, ModelInfo } from './types.ts';

/** How a node names a model. Imported flows carry cloud labels (`provider_name: "openai"`, `model_name: "gpt-4o"`). */
export interface ModelRef {
  provider?: string;
  model?: string;
  /** Connection id or name (Jasmine) / credential name or id (imported). */
  connection?: string;
  params?: Record<string, unknown>;
}

export type ModelPurpose = 'chat' | 'embedding';

export interface ConnectionHandle {
  id: string;
  name: string;
  kind: string;
  provider: LLMProvider;
  chatModel?: string | undefined;
  embeddingModel?: string | undefined;
  /** Imported model name → local model id, e.g. `{"gpt-4o": "llama3.1:8b"}`. */
  aliases?: Record<string, string>;
}

export interface ResolvedModel {
  provider: LLMProvider;
  model: string;
  connectionId: string;
  /** True when the requested model or provider did not exist locally and was mapped. */
  mapped: boolean;
}

export interface LLMRouter {
  resolve(ref: ModelRef, purpose: ModelPurpose, signal?: AbortSignal): Promise<ResolvedModel>;
}

export interface ModelRouterOptions {
  defaultChat?: string | undefined;
  defaultEmbedding?: string | undefined;
  /** How long a model listing is reused for name checks and discovery. */
  listingTtlMs?: number;
}

/**
 * Routes model references to local connections. A reference that names a local connection (by id,
 * name, or kind) runs there with the model it names; anything else (OpenAI, Anthropic, Groq…) runs on
 * the default local connection with an alias or that connection's default model. Nothing falls back to a cloud.
 */
export class ModelRouter implements LLMRouter {
  private connections: ConnectionHandle[] = [];
  private opts: ModelRouterOptions;
  private readonly listings = new Map<string, { at: number; models: Promise<ModelInfo[]> }>();

  constructor(connections: ConnectionHandle[] = [], opts: ModelRouterOptions = {}) {
    this.opts = opts;
    this.setConnections(connections, opts);
  }

  setConnections(connections: ConnectionHandle[], opts: ModelRouterOptions = this.opts): void {
    this.connections = [...connections];
    this.opts = { ...this.opts, ...opts };
    this.listings.clear();
  }

  list(): readonly ConnectionHandle[] {
    return this.connections;
  }

  get(idOrName: string): ConnectionHandle | undefined {
    const key = idOrName.toLowerCase();
    return this.connections.find((c) => c.id.toLowerCase() === key)
      ?? this.connections.find((c) => c.name.toLowerCase() === key);
  }

  defaultFor(purpose: ModelPurpose): ConnectionHandle | undefined {
    const preferred = purpose === 'chat' ? this.opts.defaultChat : this.opts.defaultEmbedding;
    return (preferred ? this.get(preferred) : undefined)
      ?? (purpose === 'embedding' ? this.connections.find((c) => c.embeddingModel && c.kind !== 'builtin') : undefined)
      ?? this.connections.find((c) => c.kind !== 'builtin')
      ?? this.connections[0];
  }

  async models(connectionId: string, signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<ModelInfo[]> {
    const conn = this.get(connectionId);
    if (!conn?.provider.listModels) return [];
    const ttl = this.opts.listingTtlMs ?? 30_000;
    const cached = this.listings.get(conn.id);
    if (cached && Date.now() - cached.at < ttl) return cached.models;
    const models = conn.provider.listModels(signal);
    this.listings.set(conn.id, { at: Date.now(), models });
    models.catch(() => this.listings.delete(conn.id));
    return models;
  }

  async resolve(ref: ModelRef, purpose: ModelPurpose, signal?: AbortSignal): Promise<ResolvedModel> {
    const named = (ref.connection ? this.get(ref.connection) : undefined)
      ?? (ref.provider ? this.get(ref.provider) ?? this.connections.find((c) => c.kind.toLowerCase() === ref.provider!.toLowerCase()) : undefined);
    const conn = named ?? this.defaultFor(purpose);
    if (!conn) throw new EngineError('PROVIDER', 'No model connection is configured; add one under Models');
    const fallback = purpose === 'chat' ? conn.chatModel : conn.embeddingModel;
    const requested = stripProviderPrefix(ref.model, ref.provider);
    const foreign = !named && (ref.provider !== undefined || ref.connection !== undefined);

    let model: string | undefined;
    let mapped = false;
    if (requested && conn.aliases?.[requested]) {
      model = conn.aliases[requested];
      mapped = true;
    } else if (requested && requested !== 'auto' && requested !== 'default' && !foreign) {
      model = requested;
      // A connection chosen explicitly gets the model it names (a missing model is the server's error to report).
      // A bare name with no connection (e.g. an imported "gpt-4o-mini") maps to the default when the server lacks it.
      if (!named && conn.provider.listModels) {
        try {
          const available = await this.models(conn.id, signal ?? AbortSignal.timeout(10_000));
          if (available.length > 0 && !available.some((m) => m.id === requested || m.id === `${requested}:latest`)) {
            model = fallback ?? 'auto';
            mapped = true;
          }
        } catch {
          /* listing unavailable: send the name as-is and let the server answer */
        }
      }
    } else {
      model = fallback ?? 'auto';
      mapped = !!requested && requested !== 'auto' && requested !== 'default';
    }
    if (!model) model = 'auto';
    if (model === 'auto' && conn.provider.listModels) {
      const found = (await this.models(conn.id, signal ?? AbortSignal.timeout(10_000)).catch(() => [] as ModelInfo[])).find((m) => m.kind === purpose);
      if (found) model = found.id;
    }
    return { provider: conn.provider, model, connectionId: conn.id, mapped };
  }
}

/** Routes every reference to one provider and default model. Handy in tests and scripts. */
export class StaticLLMRouter extends ModelRouter {
  constructor(providers: Record<string, LLMProvider>, defaultProvider: string, defaultModel: string, embeddingModel = defaultModel) {
    super(Object.entries(providers).map(([id, provider]) => ({ id, name: id, kind: provider.name, provider, chatModel: defaultModel, embeddingModel })), {
      defaultChat: defaultProvider,
      defaultEmbedding: defaultProvider,
    });
  }

  override async resolve(ref: ModelRef, purpose: ModelPurpose): Promise<ResolvedModel> {
    const conn = (ref.connection ? this.get(ref.connection) : undefined) ?? (ref.provider ? this.get(ref.provider) : undefined);
    const target = conn ?? this.defaultFor(purpose)!;
    const model = conn && ref.model ? ref.model : purpose === 'chat' ? target.chatModel! : target.embeddingModel!;
    return { provider: target.provider, model, connectionId: target.id, mapped: !conn };
  }
}

/** Imported names often carry a provider prefix (`openai/gpt-4o-mini`). */
function stripProviderPrefix(model: string | undefined, provider: string | undefined): string | undefined {
  if (!model) return model;
  const trimmed = model.trim();
  if (provider && trimmed.toLowerCase().startsWith(`${provider.toLowerCase()}/`)) return trimmed.slice(provider.length + 1);
  return trimmed;
}

export interface ChatCallOptions extends Omit<LLMRequest, 'model'> {
  ref: ModelRef;
}

export interface ChatResult extends LLMResponse {
  connectionId: string;
  mapped: boolean;
}

export async function chat(router: LLMRouter, opts: ChatCallOptions): Promise<ChatResult> {
  const { ref, ...req } = opts;
  const target = await router.resolve(ref, 'chat', req.signal);
  const res = await target.provider.generate({ ...req, model: target.model });
  return { ...res, connectionId: target.connectionId, mapped: target.mapped };
}

export async function embed(router: LLMRouter, ref: ModelRef, input: string[], signal: AbortSignal): Promise<EmbedResponse & { connectionId: string }> {
  const target = await router.resolve(ref, 'embedding', signal);
  if (!target.provider.embed) throw new EngineError('PROVIDER', `Connection ${target.connectionId} cannot create embeddings`);
  const batches: string[][] = [];
  for (let i = 0; i < input.length; i += 64) batches.push(input.slice(i, i + 64));
  const out: EmbedResponse = { vectors: [], model: target.model, inputTokens: 0 };
  for (const batch of batches) {
    const res = await target.provider.embed({ model: target.model, input: batch, signal });
    out.vectors.push(...res.vectors);
    out.model = res.model;
    out.inputTokens += res.inputTokens;
  }
  return { ...out, connectionId: target.connectionId };
}
