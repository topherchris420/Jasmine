import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Jasmine } from '../app.ts';
import { parseJson } from '../db/database.ts';
import { EngineError, toEngineError } from '../errors.ts';
import { NODE_GUIDE } from '../nodes/guide.ts';
import { markdownSections } from '../vector/markdown.ts';
import { IDENTITY, identityText } from './identity.ts';
import { INTENTS } from './planner.ts';
import { prerequisitesOf } from './readiness.ts';

/**
 * Knowledge packs: ready-made document sets Jasmine can install into a knowledge collection with one action. Bundled
 * packs (knowledge/*.json) are built by scripts/build-knowledge.ts from pinned commits of other repositories; the
 * `jasmine-docs` pack is generated from this installation's own documentation, step catalog and templates, so it always
 * describes the running version. Packs share one collection by default, so one search ranks all of them together.
 * Nothing is installed until someone asks: embedding hundreds of documents takes time on a local model.
 */

export const KNOWLEDGE_DIR = new URL('../../knowledge/', import.meta.url);
const ROOT = new URL('../../', import.meta.url);
export const PACK_COLLECTION = 'jasmine-knowledge';
export const DOCS_PACK = 'jasmine-docs';
const SCHEMA = 'jasmine-knowledge-pack/v1';
const REPOSITORY = 'https://github.com/topherchris420/Jasmine';

const PackSchema = z.object({
  schema: z.literal(SCHEMA),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(1),
  description: z.string(),
  caveats: z.array(z.string()),
  license: z.string(),
  notice: z.string(),
  sources: z.array(z.object({
    repository: z.string(), url: z.string(), commit: z.string().optional(), version: z.string().optional(),
    paths: z.array(z.object({ path: z.string(), sha256: z.string() })), license: z.string(), via: z.string().optional(),
  })),
  generator: z.string(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  documents: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), url: z.string().optional(), text: z.string().min(1), metadata: z.record(z.string(), z.unknown()).default({}) })).min(1),
});

export type KnowledgePack = z.infer<typeof PackSchema> & { origin: 'bundled' | 'generated' };

const InstallInput = z.object({
  collection: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/, 'Collection names use letters, digits, ".", ":", "_" or "-"').optional(),
  embeddingConnection: z.string().nullable().optional(),
  embeddingModel: z.string().nullable().optional(),
}).strict();

interface InstalledPack { collection: string; contentSha256: string; installedAt: string; documents: number; chunks: number; embeddingModel: string | null }
interface PackJob { collection: string; done: number; total: number; startedAt: string; error?: string; finished?: Promise<void> }

export interface PackView {
  id: string; title: string; description: string; caveats: string[]; license: string; notice: string; origin: KnowledgePack['origin'];
  sources: KnowledgePack['sources']; documents: number; characters: number; contentSha256: string;
  /** Where the pack is installed, or would be installed. */
  collection: string;
  status: 'available' | 'installed' | 'outdated' | 'installing' | 'failed';
  installed: (InstalledPack & { present: number }) | null;
  job: { done: number; total: number; startedAt: string; error?: string } | null;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Checks a pack file: its shape, and that its documents still hash to the recorded content hash. */
export function parsePack(raw: unknown, origin: KnowledgePack['origin'] = 'bundled'): KnowledgePack {
  const parsed = PackSchema.safeParse(raw);
  if (!parsed.success) throw new EngineError('BAD_PAYLOAD', `Not a knowledge pack: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const pack = parsed.data;
  if (sha256(JSON.stringify(pack.documents)) !== pack.contentSha256) throw new EngineError('BAD_PAYLOAD', `Knowledge pack ${pack.id} does not match its content hash; rebuild it with scripts/build-knowledge.ts`);
  const ids = new Set(pack.documents.map((d) => d.id));
  if (ids.size !== pack.documents.length) throw new EngineError('BAD_PAYLOAD', `Knowledge pack ${pack.id} repeats a document id`);
  return { ...pack, origin };
}

const CATEGORY_TITLES: Record<string, string> = {
  trigger: 'Triggers: how a workflow starts', response: 'Responses: how a workflow answers', ai: 'AI steps', rag: 'Knowledge and retrieval steps',
  data: 'Data steps', logic: 'Logic and flow-control steps', app: 'App, database and service steps',
};

/** Jasmine's own documentation pack, from the files and catalog of this installation. */
async function docsPack(app: Jasmine, version: string): Promise<KnowledgePack> {
  const documents: KnowledgePack['documents'] = [];
  const paths: { path: string; sha256: string }[] = [];
  const docFiles = await readdir(new URL('docs/', ROOT)).then((names) => names.filter((n) => n.endsWith('.md')).sort().map((n) => `docs/${n}`), () => []);
  for (const file of ['README.md', ...docFiles, 'sdk/README.md', 'knowledge/README.md']) {
    let markdown: string;
    try {
      markdown = await readFile(new URL(file, ROOT), 'utf8');
    } catch {
      continue; // Container images may leave some of these out.
    }
    paths.push({ path: file, sha256: sha256(markdown) });
    const sections = markdownSections(markdown);
    const title = sections[0]?.heading || (file === 'README.md' ? 'Jasmine' : file);
    for (const s of sections) {
      const first = s === sections[0];
      documents.push({
        id: `${DOCS_PACK}:${file}#${first ? 'intro' : s.anchor}`,
        title: first ? (file === 'README.md' ? 'Jasmine — overview' : title) : `${title === 'Jasmine' ? 'Jasmine' : title} — ${s.heading}`,
        url: `${REPOSITORY}/blob/master/${file}${first ? '' : `#${s.anchor}`}`,
        text: s.text.length > 8000 ? `${s.text.slice(0, 8000)} …` : s.text,
        metadata: { kind: 'jasmine-doc', file },
      });
    }
  }
  documents.push({
    id: `${DOCS_PACK}:identity`,
    title: 'Who Jasmine is',
    url: IDENTITY.origin.soul.url,
    text: `${identityText()}\n\nMy lab identity comes from ${IDENTITY.origin.soul.path} in ${IDENTITY.origin.soul.repository} (sha256 ${IDENTITY.origin.soul.sha256}); the R.A.I.N. Lab itself lives in ${IDENTITY.origin.labRepository}.`,
    metadata: { kind: 'identity' },
  });
  const catalog = app.registry.catalog().filter((n) => !n.hidden);
  for (const [category, title] of Object.entries(CATEGORY_TITLES)) {
    const nodes = catalog.filter((n) => n.category === category);
    if (!nodes.length) continue;
    documents.push({
      id: `${DOCS_PACK}:steps:${category}`,
      title: `Steps Jasmine can run — ${title}`,
      url: `${REPOSITORY}/blob/master/docs/CAPABILITIES.md`,
      text: [`${title} (${nodes.length}):`, ...nodes.map((n) => `${n.label}${n.integration ? ` [${n.integration}]` : ''}: ${NODE_GUIDE[n.type]?.summary ?? n.description}`)].join('\n'),
      metadata: { kind: 'jasmine-steps', category, steps: nodes.length },
    });
  }
  const templates = await app.templates();
  documents.push({
    id: `${DOCS_PACK}:templates`,
    title: 'Jasmine templates',
    url: `${REPOSITORY}/tree/master/examples/templates`,
    text: [`Ready-made workflows in the Templates gallery (${templates.length}):`, ...templates.map((t) => {
      const needs = prerequisitesOf(t.definition, app.registry.catalog());
      return `${t.name} (${t.category}): ${t.useCase} Input: ${t.input || 'none'}. Output: ${t.output || 'see the template'}. ${needs.modelFree ? 'Runs without a model.' : `Needs: ${needs.items.map((i) => i.label).join(', ') || 'a chat model'}.`}`;
    })].join('\n'),
    metadata: { kind: 'jasmine-templates', templates: templates.length },
  });
  documents.push({
    id: `${DOCS_PACK}:planner`,
    title: 'What Jasmine builds from a description',
    url: `${REPOSITORY}/blob/master/README.md#what-you-can-build`,
    text: `When you describe an application on the home page, my planner recognizes ${Object.keys(INTENTS).length} kinds of application: ${Object.values(INTENTS).join('; ')}. Planning is deterministic and pattern-based: steps come only from my catalog of executable steps, and a request outside these patterns gets a general model-powered API as a labelled best guess. A connected model may tailor names, instructions and categories, but it cannot add steps.`,
    metadata: { kind: 'jasmine-planner' },
  });
  const pack = {
    schema: SCHEMA as typeof SCHEMA,
    id: DOCS_PACK,
    title: 'Jasmine’s own documentation',
    description: 'My README and guides, plus who I am, every step I can run, my templates and what my planner builds, generated from this installation so it always matches the running version.',
    caveats: ['Generated from this installation; it changes when Jasmine is updated.', 'Describes what Jasmine can do. Whether a workflow works still depends on the models and data you connect.'],
    license: 'Same as Jasmine',
    notice: 'Jasmine’s own documentation.',
    sources: [{ repository: 'topherchris420/Jasmine', url: REPOSITORY, version, paths, license: 'Same as Jasmine' }],
    generator: 'src/service/packs.ts',
    contentSha256: sha256(JSON.stringify(documents)),
    documents,
  };
  return { ...pack, origin: 'generated' };
}

export class KnowledgePacks {
  private readonly app: Jasmine;
  private readonly version: string;
  private bundled: Promise<{ packs: KnowledgePack[]; problems: string[] }> | undefined;
  private docs: Promise<KnowledgePack> | undefined;
  private readonly jobs = new Map<string, PackJob>();

  constructor(app: Jasmine, version: string) {
    this.app = app;
    this.version = version;
  }

  /** Bundled packs that failed validation, by file; empty when every pack loaded. */
  async problems(): Promise<string[]> {
    return (await this.loadBundled()).problems;
  }

  async all(): Promise<KnowledgePack[]> {
    const [bundled, docs] = await Promise.all([this.loadBundled(), this.docsPack()]);
    return [docs, ...bundled.packs];
  }

  async get(id: string): Promise<KnowledgePack> {
    const pack = (await this.all()).find((p) => p.id === id);
    if (!pack) throw new EngineError('NOT_FOUND', `No knowledge pack named ${id}`);
    return pack;
  }

  private loadBundled() {
    this.bundled ??= (async () => {
      const packs: KnowledgePack[] = [];
      const problems: string[] = [];
      const files = await readdir(KNOWLEDGE_DIR).then((names) => names.filter((n) => n.endsWith('.json')).sort(), () => []);
      for (const file of files) {
        try {
          packs.push(parsePack(JSON.parse(await readFile(new URL(file, KNOWLEDGE_DIR), 'utf8'))));
        } catch (e) {
          problems.push(`${file}: ${toEngineError(e).message}`);
        }
      }
      return { packs, problems };
    })();
    return this.bundled;
  }

  private docsPack() {
    this.docs ??= docsPack(this.app, this.version).catch((e: unknown) => {
      this.docs = undefined;
      throw e;
    });
    return this.docs;
  }

  /** Collections that hold, or by default would hold, knowledge packs. */
  collections(): string[] {
    return [...new Set([PACK_COLLECTION, ...Object.values(this.records()).map((r) => r.collection)])];
  }

  private records(): Record<string, InstalledPack> {
    return this.app.settings.get<Record<string, InstalledPack>>('knowledge.packs', {});
  }

  private saveRecord(id: string, record: InstalledPack | null): void {
    const all = { ...this.records() };
    if (record) all[id] = record;
    else delete all[id];
    this.app.settings.set('knowledge.packs', all);
  }

  /** Document ids per pack in a collection, from the pack tag each installed document carries. */
  private packDocuments(collection: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (!this.app.vectors.getCollection(collection)) return out;
    for (const row of this.app.db.all<{ id: string; metadata: string }>('SELECT id, metadata FROM documents WHERE collection = ?', collection)) {
      const pack = parseJson<{ pack?: unknown }>(row.metadata, {}).pack;
      if (typeof pack === 'string') out.set(pack, [...(out.get(pack) ?? []), row.id]);
    }
    return out;
  }

  /**
   * The installed record, if the collection still holds the pack's documents (someone may have deleted them by hand).
   * `scanned` shares one scan of each collection across the packs of a listing.
   */
  private present(id: string, scanned = new Map<string, Map<string, string[]>>()): (InstalledPack & { present: number }) | null {
    const record = this.records()[id];
    if (!record) return null;
    if (!scanned.has(record.collection)) scanned.set(record.collection, this.packDocuments(record.collection));
    const present = scanned.get(record.collection)!.get(id)?.length ?? 0;
    return present > 0 ? { ...record, present } : null;
  }

  private view(pack: KnowledgePack, scanned?: Map<string, Map<string, string[]>>): PackView {
    const installed = this.present(pack.id, scanned);
    const job = this.jobs.get(pack.id);
    const status: PackView['status'] = job && !job.error ? 'installing' : job?.error ? 'failed' : !installed ? 'available' : installed.contentSha256 === pack.contentSha256 ? 'installed' : 'outdated';
    return {
      id: pack.id, title: pack.title, description: pack.description, caveats: pack.caveats, license: pack.license, notice: pack.notice, origin: pack.origin,
      sources: pack.sources, documents: pack.documents.length, characters: pack.documents.reduce((n, d) => n + d.text.length, 0), contentSha256: pack.contentSha256,
      collection: job?.collection ?? installed?.collection ?? this.records()[pack.id]?.collection ?? PACK_COLLECTION,
      status, installed,
      job: job ? { done: job.done, total: job.total, startedAt: job.startedAt, ...(job.error ? { error: job.error } : {}) } : null,
    };
  }

  async list(): Promise<PackView[]> {
    const scanned = new Map<string, Map<string, string[]>>();
    return (await this.all()).map((p) => this.view(p, scanned));
  }

  async describe(id: string): Promise<PackView> {
    return this.view(await this.get(id));
  }

  /**
   * Starts installing (or updating) a pack and returns at once; `wait` resolves when it finishes. The new copy is
   * indexed before the old one is removed, so a failed update leaves the installed version searchable.
   */
  async install(id: string, body: unknown = {}): Promise<PackView> {
    const parsed = InstallInput.safeParse(body ?? {});
    if (!parsed.success) throw new EngineError('BAD_PAYLOAD', parsed.error.issues.map((i) => i.message).join('; '));
    const input = parsed.data;
    const pack = await this.get(id);
    if (this.jobs.get(id) && !this.jobs.get(id)!.error) throw new EngineError('CONFLICT', `${pack.title} is already being installed`);
    const previous = this.records()[id];
    const collection = input.collection ?? previous?.collection ?? PACK_COLLECTION;
    const info = this.app.vectors.getCollection(collection);
    if (info && info.kind !== 'knowledge') throw new EngineError('BAD_PAYLOAD', `${collection} is a memory store, not a knowledge collection`);
    const wantsModel = input.embeddingModel !== undefined || input.embeddingConnection !== undefined;
    if (!info) {
      this.app.vectors.createCollection({
        name: collection, kind: 'knowledge',
        description: 'Jasmine’s knowledge packs: her own documentation, the R.A.I.N. Lab, Vers3Dynamics projects and the openai/math catalogue.',
        embeddingConnection: input.embeddingConnection ?? null, embeddingModel: input.embeddingModel ?? null,
      });
    } else if (wantsModel && ((input.embeddingModel ?? null) !== info.embeddingModel || (input.embeddingConnection ?? null) !== info.embeddingConnection)) {
      if (info.records > 0) throw new EngineError('CONFLICT', `${collection} already uses ${info.embeddingModel ?? 'the default embedding model'}; every pack in a collection shares its embedding model. Install into another collection to use a different one.`);
      this.app.vectors.updateCollection(collection, { embeddingConnection: input.embeddingConnection ?? null, embeddingModel: input.embeddingModel ?? null });
    }
    const job: PackJob = { collection, done: 0, total: 0, startedAt: new Date().toISOString() };
    this.jobs.set(id, job);
    job.finished = this.app.knowledge.importTexts(collection, pack.documents.map((d) => ({
      title: d.title, source: d.url ?? `pack:${pack.id}`, text: d.text,
      metadata: { ...d.metadata, pack: pack.id, packDocument: d.id, ...(d.url ? { url: d.url } : {}) },
    })), { onProgress: (done, total) => { job.done = done; job.total = total; } }).then((result) => {
      const keep = new Set(result.documentIds);
      this.app.db.transaction(() => {
        for (const old of new Set([previous?.collection ?? collection, collection])) this.removeDocuments(id, old, keep);
      });
      this.saveRecord(id, {
        collection, contentSha256: pack.contentSha256, installedAt: new Date().toISOString(), documents: result.documents, chunks: result.chunks,
        embeddingModel: this.app.vectors.getCollection(collection)?.embeddingModel ?? null,
      });
      this.jobs.delete(id);
    }).catch((e: unknown) => {
      // Recorded rather than thrown, so a failure in indexing or in clearing the old copy never leaves the pack stuck installing.
      job.error = toEngineError(e).message;
    });
    return this.view(pack);
  }

  /** Resolves when an install started by `install` has finished (or failed), with the pack's state. */
  async wait(id: string): Promise<PackView> {
    await this.jobs.get(id)?.finished;
    return this.describe(id);
  }

  private removeDocuments(id: string, collection: string, keep: Set<string> = new Set()): number {
    const ids = (this.packDocuments(collection).get(id) ?? []).filter((doc) => !keep.has(doc));
    this.app.db.transaction(() => {
      for (const doc of ids) {
        this.app.vectors.delete(collection, { documentId: doc });
        this.app.db.run('DELETE FROM documents WHERE id = ?', doc);
      }
    });
    return ids.length;
  }

  /** Removes a pack's documents. The shared pack collection goes too once nothing else is left in it. */
  async remove(id: string): Promise<{ removed: number; collectionDeleted: boolean }> {
    await this.get(id);
    if (this.jobs.get(id) && !this.jobs.get(id)!.error) throw new EngineError('CONFLICT', 'Wait for the install to finish before removing the pack');
    this.jobs.delete(id);
    const collection = this.records()[id]?.collection ?? PACK_COLLECTION;
    const removed = this.app.vectors.getCollection(collection) ? this.removeDocuments(id, collection) : 0;
    this.saveRecord(id, null);
    const left = this.app.vectors.getCollection(collection);
    const collectionDeleted = collection === PACK_COLLECTION && !!left && left.documents === 0 && left.records === 0 && this.app.vectors.deleteCollection(collection);
    return { removed, collectionDeleted };
  }
}
