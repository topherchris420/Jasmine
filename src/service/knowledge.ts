import { randomUUID } from 'node:crypto';
import { json, parseJson, type JasmineDb } from '../db/database.ts';
import { EngineError, toEngineError } from '../errors.ts';
import { crawl, scrapePage } from '../integrations/web.ts';
import { embed, type LLMRouter, type ModelRef } from '../llm/router.ts';
import { chunkText } from '../vector/chunking.ts';
import { extractDocument } from '../vector/extract.ts';
import type { VectorStore } from '../vector/store.ts';
import type { FileStore } from './files.ts';

export interface DocumentView {
  id: string;
  collection: string;
  title: string;
  source: string;
  mime: string | null;
  bytes: number;
  chunks: number;
  status: 'processing' | 'ready' | 'failed';
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface IngestRequest {
  collection: string;
  /** `file` (an uploaded file id), `text`, `url` (one page) or `crawl` (a site). */
  type: 'file' | 'text' | 'url' | 'crawl';
  fileId?: string;
  text?: string;
  url?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  chunkSize?: number;
  chunkOverlap?: number;
  crawlLimit?: number;
  crawlDepth?: number;
}

interface Row { id: string; collection: string; title: string; source: string; mime: string | null; bytes: number; chunks: number; status: string; error: string | null; metadata: string; created_at: string; updated_at: string }

interface Section { title: string; source: string; text: string; page?: number; url?: string }

/** Knowledge-base ingestion: extract → chunk → embed (collection's model) → index, tracked per document. */
export class KnowledgeService {
  private readonly db: JasmineDb;
  private readonly vectors: VectorStore;
  private readonly llm: LLMRouter;
  private readonly files: FileStore;
  private readonly fetchImpl: typeof fetch;
  private readonly jobs = new Map<string, Promise<DocumentView>>();

  constructor(db: JasmineDb, vectors: VectorStore, llm: LLMRouter, files: FileStore, fetchImpl: typeof fetch = fetch) {
    this.db = db;
    this.vectors = vectors;
    this.llm = llm;
    this.files = files;
    this.fetchImpl = fetchImpl;
  }

  list(collection: string): DocumentView[] {
    return this.db.all<Row>('SELECT * FROM documents WHERE collection = ? ORDER BY created_at DESC', collection).map(view);
  }

  get(id: string): DocumentView | undefined {
    const row = this.db.get<Row>('SELECT * FROM documents WHERE id = ?', id);
    return row ? view(row) : undefined;
  }

  /** Starts ingestion and returns the document immediately (status `processing`). */
  ingest(input: Omit<IngestRequest, 'type'> & { type?: IngestRequest['type'] }): DocumentView {
    const info = this.vectors.getCollection(input.collection);
    if (!info) throw new EngineError('NOT_FOUND', `Collection ${input.collection} does not exist`);
    // API callers may omit `type`; infer it from the one source field they sent.
    const type = input.type ?? (input.fileId ? 'file' : input.text !== undefined ? 'text' : input.url ? 'url' : undefined);
    if (type !== 'file' && type !== 'text' && type !== 'url' && type !== 'crawl') throw new EngineError('BAD_PAYLOAD', 'Send one of fileId, text, url (with type "crawl" to follow links)');
    const req: IngestRequest = { ...input, type };
    if (req.type === 'file' && !req.fileId) throw new EngineError('BAD_PAYLOAD', 'fileId is required');
    if (req.type === 'text' && !req.text?.trim()) throw new EngineError('BAD_PAYLOAD', 'text is required');
    if ((req.type === 'url' || req.type === 'crawl') && !/^https?:\/\//i.test(req.url ?? '')) throw new EngineError('BAD_PAYLOAD', 'A http(s) url is required');
    const file = req.fileId ? this.files.info(req.fileId) : undefined;
    if (req.type === 'file' && !file) throw new EngineError('NOT_FOUND', 'Uploaded file not found');
    const id = randomUUID();
    const now = new Date().toISOString();
    const title = req.title?.trim() || file?.name || (req.url ? req.url : 'Pasted text');
    const source = req.type === 'file' ? `file:${req.fileId}` : req.type === 'text' ? 'text' : `${req.type}:${req.url}`;
    this.db.run(
      'INSERT INTO documents (id, collection, title, source, mime, bytes, chunks, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
      id, req.collection, title, source, file?.mime ?? (req.type === 'text' ? 'text/plain' : 'text/html'), file?.size ?? req.text?.length ?? 0, 'processing', json(req.metadata ?? {}), now, now,
    );
    const job = this.process(id, req, title).finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    job.catch(() => {});
    return this.get(id)!;
  }

  /** Resolves when a document finishes processing. */
  async wait(id: string): Promise<DocumentView> {
    return (await this.jobs.get(id)) ?? this.get(id) ?? Promise.reject(new EngineError('NOT_FOUND', 'Document not found'));
  }

  remove(id: string): boolean {
    const doc = this.get(id);
    if (!doc) return false;
    this.vectors.delete(doc.collection, { documentId: id });
    this.db.run('DELETE FROM documents WHERE id = ?', id);
    return true;
  }

  private async process(id: string, req: IngestRequest, title: string): Promise<DocumentView> {
    const signal = AbortSignal.timeout(30 * 60_000);
    try {
      const sections = await this.sections(req, title, signal);
      const size = Math.min(Math.max(Math.trunc(req.chunkSize ?? 1000), 100), 8000);
      const overlap = Math.min(Math.max(Math.trunc(req.chunkOverlap ?? Math.round(size * 0.15)), 0), size - 1);
      const chunks: { text: string; metadata: Record<string, unknown> }[] = [];
      for (const section of sections) {
        chunkText(section.text, { chunkSize: size, chunkOverlap: overlap }).forEach((text, i) => {
          chunks.push({
            text,
            metadata: {
              content: text, title: section.title, source: section.url ?? section.source, documentId: id, chunk: i,
              ...(section.page !== undefined ? { page: section.page } : {}), ...(req.metadata ?? {}),
            },
          });
        });
      }
      if (chunks.length === 0) throw new EngineError('BAD_PAYLOAD', 'No text could be extracted (scanned PDFs need OCR first)');
      const info = this.vectors.getCollection(req.collection)!;
      const ref: ModelRef = { ...(info.embeddingConnection ? { connection: info.embeddingConnection } : {}), ...(info.embeddingModel ? { model: info.embeddingModel } : {}) };
      const embedded = await embed(this.llm, ref, chunks.map((c) => c.text), signal);
      if (!info.embeddingModel && this.vectors.getCollection(req.collection)!.records === 0) {
        this.vectors.updateCollection(req.collection, { embeddingConnection: embedded.connectionId, embeddingModel: embedded.model });
      }
      this.vectors.upsert(req.collection, chunks.map((c, i) => ({ id: `${id}:${i}`, text: c.text, metadata: c.metadata, vector: embedded.vectors[i]!, documentId: id })));
      this.db.run("UPDATE documents SET status = 'ready', chunks = ?, error = NULL, updated_at = ? WHERE id = ?", chunks.length, new Date().toISOString(), id);
    } catch (e) {
      this.db.run("UPDATE documents SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", toEngineError(e).message, new Date().toISOString(), id);
    }
    return this.get(id)!;
  }

  private async sections(req: IngestRequest, title: string, signal: AbortSignal): Promise<Section[]> {
    switch (req.type) {
      case 'text':
        return [{ title, source: 'text', text: req.text! }];
      case 'file': {
        const file = await this.files.read(req.fileId!);
        const doc = extractDocument(file.bytes, { filename: file.name, mime: file.mime });
        if (doc.format === 'csv' && doc.rows) {
          return doc.rows.map((row, i) => ({ title, source: file.name, page: i + 1, text: Object.entries(row).map(([k, v]) => `${k}: ${String(v)}`).join('\n') }));
        }
        return doc.pages.map((text, i) => ({ title, source: file.name, text, ...(doc.pages.length > 1 ? { page: i + 1 } : {}) }));
      }
      case 'url': {
        const page = await scrapePage(req.url!, { fetch: this.fetchImpl, signal });
        return [{ title: req.title?.trim() || page.title || page.url, source: page.url, url: page.url, text: page.markdown }];
      }
      case 'crawl': {
        const pages = await crawl(req.url!, { fetch: this.fetchImpl, signal, limit: req.crawlLimit ?? 20, maxDepth: req.crawlDepth ?? 2 });
        return pages.map((p) => ({ title: p.title || p.url, source: p.url, url: p.url, text: p.markdown }));
      }
    }
  }
}

function view(r: Row): DocumentView {
  return {
    id: r.id, collection: r.collection, title: r.title, source: r.source, mime: r.mime, bytes: r.bytes, chunks: r.chunks,
    status: r.status as DocumentView['status'], error: r.error, metadata: parseJson(r.metadata, {}), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
