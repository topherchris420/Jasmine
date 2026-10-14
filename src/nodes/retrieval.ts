import { EngineError } from '../errors.ts';
import { embed, type ModelRef } from '../llm/router.ts';
import type { MetadataFilter } from '../vector/filters.ts';
import type { CollectionInfo, SearchHit, SearchMode, VectorStore } from '../vector/store.ts';
import { modelConfigs, modelLabel } from './common.ts';
import type { NodeContext, Usage } from './types.ts';

export function vectorStoreOf(ctx: NodeContext): VectorStore {
  if (!ctx.services.vectors) throw new EngineError('INTERNAL', 'No vector store is configured in this runtime');
  return ctx.services.vectors;
}

/** The embedding model for a collection: the node's choice, else the collection's, else the default. */
export function embeddingRefFor(ctx: NodeContext, collection: CollectionInfo | undefined, field = 'embeddingModelName'): ModelRef {
  const fromNode = modelConfigs(ctx.values[field])[0];
  if (fromNode) return fromNode;
  if (collection?.embeddingConnection || collection?.embeddingModel) {
    return { ...(collection.embeddingConnection ? { connection: collection.embeddingConnection } : {}), ...(collection.embeddingModel ? { model: collection.embeddingModel } : {}) };
  }
  return {};
}

export interface EmbedOutcome {
  vectors: number[][];
  model: string;
  connectionId: string;
  usage: Partial<Usage>;
  label: string;
}

export async function embedTexts(ctx: NodeContext, ref: ModelRef, texts: string[]): Promise<EmbedOutcome> {
  const res = await embed(ctx.services.llm, ref, texts, ctx.signal);
  return { vectors: res.vectors, model: res.model, connectionId: res.connectionId, usage: { inputTokens: res.inputTokens }, label: modelLabel(res.connectionId, res.model) };
}

/** Records which model produced a collection's vectors, so later searches embed queries the same way. */
export function rememberEmbedding(store: VectorStore, collection: string, outcome: EmbedOutcome): void {
  const info = store.getCollection(collection);
  if (info && !info.embeddingModel && info.records === 0) {
    store.updateCollection(collection, { embeddingConnection: outcome.connectionId, embeddingModel: outcome.model });
  }
}

export interface RetrieveOptions {
  collection: string;
  query: string;
  mode: SearchMode;
  limit: number;
  certainty?: number;
  alpha?: number;
  fusion?: 'relative' | 'ranked';
  filter?: MetadataFilter | undefined;
  embeddingField?: string;
}

export interface RetrieveOutcome {
  hits: SearchHit[];
  usage: Partial<Usage>;
  models: string[];
}

export async function retrieve(ctx: NodeContext, o: RetrieveOptions): Promise<RetrieveOutcome> {
  const store = vectorStoreOf(ctx);
  const info = store.getCollection(o.collection);
  if (!info) throw new EngineError('NOT_FOUND', `Vector database "${o.collection}" does not exist; create it under Context or index into it first`);
  if (info.records === 0) return { hits: [], usage: {}, models: [] };
  let vector: number[] | undefined;
  let usage: Partial<Usage> = {};
  const models: string[] = [];
  if (o.mode !== 'keyword') {
    if (!o.query.trim()) return { hits: [], usage, models };
    const outcome = await embedTexts(ctx, embeddingRefFor(ctx, info, o.embeddingField), [o.query]);
    vector = outcome.vectors[0];
    usage = outcome.usage;
    models.push(outcome.label);
  }
  const hits = store.search(o.collection, {
    mode: o.mode, query: o.query, limit: o.limit,
    ...(vector ? { vector } : {}),
    ...(o.certainty !== undefined ? { certainty: o.certainty } : {}),
    ...(o.alpha !== undefined ? { alpha: o.alpha } : {}),
    ...(o.fusion ? { fusion: o.fusion } : {}),
    ...(o.filter ? { filter: o.filter } : {}),
  });
  return { hits, usage, models };
}

/** Weaviate-shaped result object, as imported flows expect: stored properties plus `_additional`. */
export function toSearchResult(hit: SearchHit): Record<string, unknown> {
  const props = { ...hit.metadata };
  if (props['content'] === undefined && props['text'] === undefined && props['pageContent'] === undefined) props['content'] = hit.text;
  const additional: Record<string, unknown> = { id: hit.id, score: hit.score };
  if (hit.certainty !== undefined) {
    additional['certainty'] = hit.certainty;
    additional['distance'] = Math.round((1 - (hit.vectorScore ?? 0)) * 1e6) / 1e6;
  }
  return { ...props, _additional: additional, ...(hit.certainty !== undefined ? { certainty: hit.certainty } : {}), score: hit.score };
}

/** Text used for keyword search and as LLM context for a stored object. */
export function textOf(metadata: Record<string, unknown>): string {
  for (const key of ['content', 'pageContent', 'text', 'chunk', 'body', 'memory', 'description']) {
    const v = metadata[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return Object.entries(metadata)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}
