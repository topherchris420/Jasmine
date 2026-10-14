import { createHash, randomUUID } from 'node:crypto';
import { json, parseJson, type JasmineDb } from '../db/database.ts';
import { EngineError } from '../errors.ts';
import { tokenize } from '../llm/mock.ts';
import { matchesFilter, type MetadataFilter } from './filters.ts';

export interface CollectionInfo {
  name: string;
  description: string;
  dimension: number | null;
  metric: 'cosine';
  kind: 'knowledge' | 'memory';
  embeddingConnection: string | null;
  embeddingModel: string | null;
  records: number;
  documents: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionInput {
  name: string;
  description?: string;
  kind?: 'knowledge' | 'memory';
  embeddingConnection?: string | null;
  embeddingModel?: string | null;
}

export interface RecordInput {
  id?: string;
  text: string;
  metadata?: Record<string, unknown>;
  vector?: number[];
  documentId?: string;
}

export interface StoredRecord {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  documentId: string | null;
  createdAt: string;
  updatedAt: string;
  vector?: number[];
}

export type SearchMode = 'vector' | 'keyword' | 'hybrid';

export interface SearchOptions {
  mode?: SearchMode;
  /** Query text, used for keyword and hybrid search. */
  query?: string;
  /** Query embedding, used for vector and hybrid search. */
  vector?: number[];
  limit?: number;
  /** Minimum vector certainty, (1 + cosine) / 2, between 0 and 1. */
  certainty?: number;
  /** Hybrid only: weight of the vector score; 1 = pure vector, 0 = pure keyword. */
  alpha?: number;
  /** Hybrid only: `relative` (min-max scores, Weaviate relativeScoreFusion) or `ranked` (reciprocal rank). */
  fusion?: 'relative' | 'ranked';
  filter?: MetadataFilter;
}

export interface SearchHit {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  score: number;
  vectorScore?: number;
  keywordScore?: number;
  certainty?: number;
  documentId: string | null;
}

export type DuplicateMode = 'overwrite' | 'ignore' | 'error';

export interface UpsertResult {
  inserted: number;
  updated: number;
  skipped: number;
  ids: string[];
}

interface Row { rowid: number; id: string; text: string; metadata: string; vector: Uint8Array | null; document_id: string | null; created_at: string; updated_at: string }
interface CollectionRow { name: string; description: string; dimension: number | null; metric: string; kind: string; embedding_connection: string | null; embedding_model: string | null; created_at: string; updated_at: string }

interface ScanCache {
  ids: string[];
  vectors: Float32Array;
  metadata: Record<string, unknown>[];
  dimension: number;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

/** Local vector database: SQLite rows + FTS5 keyword index + an in-memory float32 matrix per collection. */
export class VectorStore {
  private readonly db: JasmineDb;
  private readonly cache = new Map<string, ScanCache>();

  constructor(db: JasmineDb) {
    this.db = db;
  }

  /* ---------- collections ---------- */

  listCollections(kind?: 'knowledge' | 'memory'): CollectionInfo[] {
    const rows = kind
      ? this.db.all<CollectionRow>('SELECT * FROM vector_collections WHERE kind = ? ORDER BY name', kind)
      : this.db.all<CollectionRow>('SELECT * FROM vector_collections ORDER BY name');
    return rows.map((r) => this.info(r));
  }

  getCollection(name: string): CollectionInfo | undefined {
    const row = this.db.get<CollectionRow>('SELECT * FROM vector_collections WHERE name = ?', name);
    return row ? this.info(row) : undefined;
  }

  createCollection(input: CollectionInput): CollectionInfo {
    if (!NAME_RE.test(input.name)) throw new EngineError('BAD_PAYLOAD', 'Collection names use letters, digits, ".", ":", "_" or "-" (max 100)');
    if (this.getCollection(input.name)) throw new EngineError('CONFLICT', `Collection ${input.name} already exists`);
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO vector_collections (name, description, kind, embedding_connection, embedding_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.name, input.description ?? '', input.kind ?? 'knowledge', input.embeddingConnection ?? null, input.embeddingModel ?? null, now, now,
    );
    return this.getCollection(input.name)!;
  }

  ensureCollection(name: string, defaults: Omit<CollectionInput, 'name'> = {}): CollectionInfo {
    return this.getCollection(name) ?? this.createCollection({ name, ...defaults });
  }

  updateCollection(name: string, changes: Partial<Omit<CollectionInput, 'name' | 'kind'>>): CollectionInfo {
    const current = this.getCollection(name);
    if (!current) throw new EngineError('NOT_FOUND', `Collection ${name} not found`);
    const model = changes.embeddingModel === undefined ? current.embeddingModel : changes.embeddingModel;
    const connection = changes.embeddingConnection === undefined ? current.embeddingConnection : changes.embeddingConnection;
    if (current.records > 0 && (model !== current.embeddingModel || connection !== current.embeddingConnection)) {
      throw new EngineError('CONFLICT', 'Clear the collection before changing its embedding model; stored vectors would no longer be comparable');
    }
    this.db.run(
      'UPDATE vector_collections SET description = ?, embedding_connection = ?, embedding_model = ?, updated_at = ? WHERE name = ?',
      changes.description ?? current.description, connection, model, new Date().toISOString(), name,
    );
    return this.getCollection(name)!;
  }

  deleteCollection(name: string): boolean {
    this.cache.delete(name);
    return Number(this.db.run('DELETE FROM vector_collections WHERE name = ?', name).changes) > 0;
  }

  clear(name: string): number {
    this.requireCollection(name);
    this.cache.delete(name);
    return this.db.transaction(() => {
      const n = Number(this.db.run('DELETE FROM vector_records WHERE collection = ?', name).changes);
      this.db.run('DELETE FROM documents WHERE collection = ?', name);
      this.db.run('UPDATE vector_collections SET dimension = NULL, updated_at = ? WHERE name = ?', new Date().toISOString(), name);
      return n;
    });
  }

  /* ---------- records ---------- */

  upsert(collection: string, records: RecordInput[], opts: { duplicate?: DuplicateMode } = {}): UpsertResult {
    const info = this.requireCollection(collection);
    const duplicate = opts.duplicate ?? 'overwrite';
    const result: UpsertResult = { inserted: 0, updated: 0, skipped: 0, ids: [] };
    let dimension = info.dimension;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const record of records) {
        if (typeof record.text !== 'string') throw new EngineError('BAD_PAYLOAD', 'Every record needs text');
        let blob: Uint8Array | null = null;
        if (record.vector) {
          if (!record.vector.length || !record.vector.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new EngineError('BAD_PAYLOAD', 'Vectors must be non-empty arrays of finite numbers');
          if (dimension === null) {
            dimension = record.vector.length;
            this.db.run('UPDATE vector_collections SET dimension = ? WHERE name = ?', dimension, collection);
          } else if (record.vector.length !== dimension) {
            throw new EngineError('BAD_PAYLOAD', `Collection ${collection} stores ${dimension}-dimensional vectors; got ${record.vector.length}. Use the collection's embedding model.`);
          }
          blob = toBlob(normalize(record.vector));
        }
        const id = record.id ?? randomUUID();
        const existing = this.db.get<{ rowid: number }>('SELECT rowid FROM vector_records WHERE collection = ? AND id = ?', collection, id);
        if (existing) {
          if (duplicate === 'ignore') {
            result.skipped++;
            result.ids.push(id);
            continue;
          }
          if (duplicate === 'error') throw new EngineError('CONFLICT', `Record ${id} already exists in ${collection}`);
          this.db.run(
            'UPDATE vector_records SET text = ?, metadata = ?, vector = ?, document_id = ?, updated_at = ? WHERE rowid = ?',
            record.text, json(record.metadata ?? {}), blob, record.documentId ?? null, now, existing.rowid,
          );
          result.updated++;
        } else {
          this.db.run(
            'INSERT INTO vector_records (collection, id, text, metadata, vector, document_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            collection, id, record.text, json(record.metadata ?? {}), blob, record.documentId ?? null, now, now,
          );
          result.inserted++;
        }
        result.ids.push(id);
      }
      this.db.run('UPDATE vector_collections SET updated_at = ? WHERE name = ?', now, collection);
    });
    this.cache.delete(collection);
    return result;
  }

  get(collection: string, id: string, withVector = false): StoredRecord | undefined {
    const row = this.db.get<Row>('SELECT rowid, * FROM vector_records WHERE collection = ? AND id = ?', collection, id);
    return row ? toRecord(row, withVector) : undefined;
  }

  list(collection: string, opts: { limit?: number; offset?: number; filter?: MetadataFilter; documentId?: string } = {}): { records: StoredRecord[]; total: number } {
    this.requireCollection(collection);
    const limit = clampInt(opts.limit, 1, 1000, 50);
    const offset = clampInt(opts.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    if (!opts.filter) {
      const where = opts.documentId ? 'collection = ? AND document_id = ?' : 'collection = ?';
      const params = opts.documentId ? [collection, opts.documentId] : [collection];
      const total = this.db.get<{ n: number }>(`SELECT count(*) AS n FROM vector_records WHERE ${where}`, ...params)!.n;
      const rows = this.db.all<Row>(`SELECT rowid, * FROM vector_records WHERE ${where} ORDER BY rowid LIMIT ? OFFSET ?`, ...params, limit, offset);
      return { records: rows.map((r) => toRecord(r)), total };
    }
    const all = this.db.all<Row>('SELECT rowid, * FROM vector_records WHERE collection = ? ORDER BY rowid', collection)
      .map((r) => toRecord(r))
      .filter((r) => (!opts.documentId || r.documentId === opts.documentId) && matchesFilter(r.metadata, opts.filter));
    return { records: all.slice(offset, offset + limit), total: all.length };
  }

  delete(collection: string, selector: { ids?: string[]; filter?: MetadataFilter; documentId?: string }): number {
    this.requireCollection(collection);
    let removed = 0;
    this.db.transaction(() => {
      if (selector.ids?.length) {
        for (const id of selector.ids) removed += Number(this.db.run('DELETE FROM vector_records WHERE collection = ? AND id = ?', collection, id).changes);
      }
      if (selector.documentId) {
        removed += Number(this.db.run('DELETE FROM vector_records WHERE collection = ? AND document_id = ?', collection, selector.documentId).changes);
      }
      if (selector.filter) {
        const rows = this.db.all<{ rowid: number; metadata: string }>('SELECT rowid, metadata FROM vector_records WHERE collection = ?', collection);
        for (const r of rows) {
          if (matchesFilter(parseJson(r.metadata, {}), selector.filter)) removed += Number(this.db.run('DELETE FROM vector_records WHERE rowid = ?', r.rowid).changes);
        }
      }
    });
    this.cache.delete(collection);
    return removed;
  }

  count(collection: string): number {
    return this.db.get<{ n: number }>('SELECT count(*) AS n FROM vector_records WHERE collection = ?', collection)!.n;
  }

  /* ---------- search ---------- */

  search(collection: string, opts: SearchOptions): SearchHit[] {
    this.requireCollection(collection);
    const limit = clampInt(opts.limit, 1, 1000, 5);
    const mode = opts.mode ?? (opts.vector ? (opts.query ? 'hybrid' : 'vector') : 'keyword');
    if ((mode === 'vector' || mode === 'hybrid') && !opts.vector) throw new EngineError('BAD_PAYLOAD', `${mode} search needs a query vector`);
    if ((mode === 'keyword' || mode === 'hybrid') && !opts.query?.trim()) {
      if (mode === 'keyword') throw new EngineError('BAD_PAYLOAD', 'Keyword search needs query text');
    }
    const minCertainty = opts.certainty ?? 0;

    if (mode === 'vector') {
      return this.vectorCandidates(collection, opts.vector!, opts.filter, limit, minCertainty).map((c) => this.hit(collection, c.id, c.similarity, { vectorScore: c.similarity, certainty: c.certainty }));
    }
    if (mode === 'keyword') {
      return this.keywordCandidates(collection, opts.query!, opts.filter, limit).map((c) => this.hit(collection, c.id, c.score, { keywordScore: c.score }));
    }

    // Hybrid: relative score fusion (min-max normalise each list, then weight), as in Weaviate.
    const alpha = Math.min(Math.max(opts.alpha ?? 0.5, 0), 1);
    const pool = Math.min(limit * 4, 1000);
    const vec = this.vectorCandidates(collection, opts.vector!, opts.filter, pool, minCertainty);
    const kw = opts.query?.trim() ? this.keywordCandidates(collection, opts.query, opts.filter, pool) : [];
    const ranked = opts.fusion === 'ranked';
    const vNorm = ranked ? vec.map((_, i) => 1 / (60 + i)) : minMax(vec.map((c) => c.similarity));
    const kNorm = ranked ? kw.map((_, i) => 1 / (60 + i)) : minMax(kw.map((c) => c.score));
    const fused = new Map<string, { score: number; vectorScore?: number; keywordScore?: number; certainty?: number }>();
    vec.forEach((c, i) => fused.set(c.id, { score: alpha * vNorm[i]!, vectorScore: c.similarity, certainty: c.certainty }));
    kw.forEach((c, i) => {
      const entry = fused.get(c.id) ?? { score: 0 };
      entry.score += (1 - alpha) * kNorm[i]!;
      entry.keywordScore = c.score;
      fused.set(c.id, entry);
    });
    return [...fused.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([id, s]) => this.hit(collection, id, s.score, s));
  }

  private vectorCandidates(collection: string, query: number[], filter: MetadataFilter | undefined, limit: number, minCertainty: number) {
    const scan = this.scan(collection);
    if (!scan) return [];
    if (query.length !== scan.dimension) {
      throw new EngineError('BAD_PAYLOAD', `Query vector has ${query.length} dimensions but ${collection} stores ${scan.dimension}; embed the query with the collection's model`);
    }
    const q = normalize(query);
    const d = scan.dimension;
    const top: { id: string; similarity: number; certainty: number }[] = [];
    for (let i = 0; i < scan.ids.length; i++) {
      let dot = 0;
      const base = i * d;
      for (let j = 0; j < d; j++) dot += q[j]! * scan.vectors[base + j]!;
      const certainty = (1 + dot) / 2;
      if (certainty < minCertainty) continue;
      if (top.length === limit && dot <= top[top.length - 1]!.similarity) continue;
      if (filter && !matchesFilter(scan.metadata[i]!, filter)) continue;
      const entry = { id: scan.ids[i]!, similarity: dot, certainty };
      let at = top.findIndex((t) => t.similarity < dot);
      if (at < 0) at = top.length;
      top.splice(at, 0, entry);
      if (top.length > limit) top.pop();
    }
    return top;
  }

  private keywordCandidates(collection: string, query: string, filter: MetadataFilter | undefined, limit: number) {
    const terms = [...new Set(tokenize(query))].slice(0, 32);
    if (terms.length === 0) return [];
    const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    const fetch = filter ? Math.min(limit * 20, 5000) : limit;
    const rows = this.db.all<{ id: string; metadata: string; rank: number }>(
      `SELECT r.id AS id, r.metadata AS metadata, bm25(vector_fts) AS rank FROM vector_fts JOIN vector_records r ON r.rowid = vector_fts.rowid
       WHERE vector_fts MATCH ? AND r.collection = ? ORDER BY rank LIMIT ?`,
      match, collection, fetch,
    );
    return rows
      .filter((r) => !filter || matchesFilter(parseJson(r.metadata, {}), filter))
      .slice(0, limit)
      .map((r) => ({ id: r.id, score: -r.rank }));
  }

  private hit(collection: string, id: string, score: number, extra: Partial<SearchHit>): SearchHit {
    const r = this.get(collection, id)!;
    return { id, text: r.text, metadata: r.metadata, documentId: r.documentId, score: round(score), ...roundAll(extra) };
  }

  private scan(collection: string): ScanCache | undefined {
    const cached = this.cache.get(collection);
    if (cached) return cached;
    const info = this.getCollection(collection);
    if (!info?.dimension) return undefined;
    const rows = this.db.all<{ id: string; vector: Uint8Array; metadata: string }>(
      'SELECT id, vector, metadata FROM vector_records WHERE collection = ? AND vector IS NOT NULL ORDER BY rowid', collection,
    );
    const d = info.dimension;
    const vectors = new Float32Array(rows.length * d);
    rows.forEach((r, i) => vectors.set(fromBlob(r.vector), i * d));
    const scan: ScanCache = { ids: rows.map((r) => r.id), vectors, metadata: rows.map((r) => parseJson(r.metadata, {})), dimension: d };
    this.cache.set(collection, scan);
    return scan;
  }

  private requireCollection(name: string): CollectionInfo {
    const info = this.getCollection(name);
    if (!info) throw new EngineError('NOT_FOUND', `Vector collection "${name}" does not exist; create it under Context`);
    return info;
  }

  private info(r: CollectionRow): CollectionInfo {
    const counts = this.db.get<{ records: number; documents: number }>(
      'SELECT (SELECT count(*) FROM vector_records WHERE collection = ?) AS records, (SELECT count(*) FROM documents WHERE collection = ?) AS documents', r.name, r.name,
    )!;
    return {
      name: r.name, description: r.description, dimension: r.dimension, metric: 'cosine', kind: r.kind === 'memory' ? 'memory' : 'knowledge',
      embeddingConnection: r.embedding_connection, embeddingModel: r.embedding_model, records: counts.records, documents: counts.documents,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
}

/** Stable record id from selected metadata fields, so re-indexing the same source overwrites instead of duplicating. */
export function primaryKeyId(metadata: Record<string, unknown>, keys: string[], text: string): string {
  const basis = keys.length ? keys.map((k) => JSON.stringify(metadata[k] ?? null)).join('|') : text;
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

function normalize(v: number[]): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Float32Array.from(v, (x) => x / norm);
}

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

function toRecord(r: Row, withVector = false): StoredRecord {
  return {
    id: r.id, text: r.text, metadata: parseJson(r.metadata, {}), documentId: r.document_id, createdAt: r.created_at, updatedAt: r.updated_at,
    ...(withVector && r.vector ? { vector: Array.from(fromBlob(r.vector)) } : {}),
  };
}

function minMax(values: number[]): number[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return values.map((v) => (hi === lo ? 1 : (v - lo) / (hi - lo)));
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;
function roundAll(extra: Partial<SearchHit>): Partial<SearchHit> {
  const out: Partial<SearchHit> = {};
  if (extra.vectorScore !== undefined) out.vectorScore = round(extra.vectorScore);
  if (extra.keywordScore !== undefined) out.keywordScore = round(extra.keywordScore);
  if (extra.certainty !== undefined) out.certainty = round(extra.certainty);
  return out;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
