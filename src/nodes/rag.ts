import { EngineError } from '../errors.ts';
import type { Diagnostic, FlowNode } from '../flow/schema.ts';
import { resolveValue } from '../flow/template.ts';
import { chunkText } from '../vector/chunking.ts';
import { extractDocument } from '../vector/extract.ts';
import { primaryKeyId, type RecordInput } from '../vector/store.ts';
import { generate, extractJson, parseFilterValue } from './ai.ts';
import { bool, f, jsonField, jsonish, loadFile, num, opts, required, str, val } from './common.ts';
import { embedTexts, embeddingRefFor, rememberEmbedding, retrieve, textOf, toSearchResult, vectorStoreOf } from './retrieval.ts';
import type { NodeContext, NodeHandler, Usage } from './types.ts';

const collectionName = (ctx: NodeContext, key = 'vectorDB'): string => {
  const raw = ctx.values[key];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const name = str(resolveValue(first ?? '', ctx.scope, opts(ctx))).trim();
  if (!name) throw new EngineError('BAD_PAYLOAD', `${key} is required`);
  return name;
};

const needsDb = (node: FlowNode, key = 'vectorDB'): Diagnostic[] => {
  const v = node.values[key];
  return !v || (Array.isArray(v) && !v.length) ? [{ severity: 'error', code: 'FIELD_REQUIRED', message: `${key} is required`, nodeId: node.id }] : [];
};

/* ---------------- chunking ---------------- */

/** Line range of a chunk inside its source, like LangChain's `metadata.loc.lines`. */
function locate(source: string, chunk: string, from: number): { start: number; lines: { from: number; to: number } } {
  const at = source.indexOf(chunk.slice(0, 200), from);
  const start = at >= 0 ? at : from;
  const before = source.slice(0, start).split('\n').length;
  return { start, lines: { from: before, to: before + chunk.split('\n').length - 1 } };
}

const chunkHandler: NodeHandler = {
  type: 'chunkNode',
  kind: 'action',
  spec: {
    label: 'Chunking', category: 'rag', icon: 'chunk', description: 'Split text into overlapping chunks for embedding.',
    fields: [
      f.text('chunkField', 'Text', { required: true, placeholder: '{{extractFromFileNode_1.output.files[0].data}}' }),
      f.select('chunkingType', 'Strategy', [['recursiveCharacterTextSplitter', 'Recursive (paragraphs → sentences → words)'], ['characterTextSplitter', 'Single separator'], ['markdownTextSplitter', 'Markdown sections']]),
      f.num('numOfChars', 'Chunk size (characters)'), f.num('overlapChars', 'Overlap (characters)'),
      { key: 'separators', label: 'Separators', type: 'stringList', advanced: true },
    ],
    outputs: [{ path: 'chunks', type: 'array', description: '[{ pageContent, metadata: { loc } }]' }, { path: 'chunks[:].pageContent', type: 'string[]' }],
    defaults: () => ({ nodeName: 'Chunking', chunkField: '', chunkingType: 'recursiveCharacterTextSplitter', numOfChars: 1000, overlapChars: 100, separators: ['\n\n', '\n', ' '] }),
  },
  validate: (node) => required(node, 'chunkField'),
  async run(ctx) {
    const raw = jsonish(val(ctx, 'chunkField', ''));
    const sources = (Array.isArray(raw) ? raw : [raw]).map((x) => (x && typeof x === 'object' ? str((x as Record<string, unknown>)['pageContent'] ?? (x as Record<string, unknown>)['content'] ?? (x as Record<string, unknown>)['text'] ?? x) : str(x)));
    const type = str(ctx.values['chunkingType']);
    const separators = jsonish(ctx.values['separators']);
    const chunks: { pageContent: string; metadata: Record<string, unknown> }[] = [];
    sources.forEach((source, index) => {
      let cursor = 0;
      for (const piece of chunkText(source, {
        chunkSize: num(val(ctx, 'numOfChars'), 1000), chunkOverlap: num(val(ctx, 'overlapChars'), 100),
        strategy: type === 'characterTextSplitter' ? 'character' : type === 'markdownTextSplitter' ? 'markdown' : 'recursive',
        ...(Array.isArray(separators) && separators.length ? { separators: separators.map(String) } : {}),
      })) {
        const loc = locate(source, piece, cursor);
        cursor = loc.start + 1;
        chunks.push({ pageContent: piece, metadata: { loc: { lines: loc.lines }, ...(sources.length > 1 ? { source: index } : {}) } });
      }
    });
    return { output: { chunks } };
  },
};

/* ---------------- embeddings ---------------- */

function textsOf(value: unknown): string[] {
  const v = jsonish(value);
  const list = Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v];
  return list.map((x) => (x && typeof x === 'object' ? str((x as Record<string, unknown>)['pageContent'] ?? (x as Record<string, unknown>)['content'] ?? (x as Record<string, unknown>)['text'] ?? x) : str(x)));
}

const vectorizeHandler: NodeHandler = {
  type: 'vectorizeNode',
  kind: 'action',
  spec: {
    label: 'Vectorize', category: 'rag', icon: 'vector', description: 'Turn text (or a list of texts / chunks) into embedding vectors with a local model.',
    fields: [f.text('inputText', 'Texts', { required: true, placeholder: '{{chunkNode_1.output.chunks[:].pageContent}}' }), f.embedding()],
    outputs: [{ path: 'vectors', type: 'number[][]' }],
    defaults: () => ({ nodeName: 'Vectorize', inputText: '' }),
  },
  validate: (node) => required(node, 'inputText'),
  async run(ctx) {
    const texts = textsOf(val(ctx, 'inputText', []));
    if (texts.length === 0) return { output: { vectors: [] } };
    const outcome = await embedTexts(ctx, embeddingRefFor(ctx, undefined), texts);
    return { output: { vectors: outcome.vectors, _meta: { model_name: outcome.model, model_provider: outcome.connectionId, prompt_tokens: outcome.usage.inputTokens ?? 0 } }, usage: outcome.usage, models: [outcome.label] };
  },
};

/* ---------------- indexing ---------------- */

interface IndexOutcome { recordsIndexed: number; duplicateRecordsDeleted: number; skipped: number; ids: string[]; usage: Partial<Usage>; models: string[] }

async function indexRecords(ctx: NodeContext, collection: string): Promise<IndexOutcome> {
  const store = vectorStoreOf(ctx);
  const info = store.ensureCollection(collection);
  const metadataRaw = jsonish(val(ctx, 'metadataField', []));
  const metadata = (Array.isArray(metadataRaw) ? metadataRaw : metadataRaw ? [metadataRaw] : []).map((m) =>
    m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : { content: str(m) });
  let vectors = jsonish(val(ctx, 'vectorsField', undefined, false)) as number[][] | undefined;
  let usage: Partial<Usage> = {};
  const models: string[] = [];
  if (!Array.isArray(vectors) || vectors.length === 0) {
    // No precomputed vectors: embed each object's text with the collection's model.
    if (metadata.length === 0) return { recordsIndexed: 0, duplicateRecordsDeleted: 0, skipped: 0, ids: [], usage, models };
    const outcome = await embedTexts(ctx, embeddingRefFor(ctx, info), metadata.map(textOf));
    vectors = outcome.vectors;
    usage = outcome.usage;
    models.push(outcome.label);
    rememberEmbedding(store, collection, outcome);
  } else if (!info.embeddingModel) {
    const ref = embeddingRefFor(ctx, info);
    if (ref.model || ref.connection) {
      const target = await ctx.services.llm.resolve(ref, 'embedding', ctx.signal).catch(() => undefined);
      if (target && store.getCollection(collection)!.records === 0) store.updateCollection(collection, { embeddingConnection: target.connectionId, embeddingModel: target.model });
    }
  }
  if (metadata.length && vectors.length !== metadata.length) throw new EngineError('BAD_PAYLOAD', `Got ${vectors.length} vectors but ${metadata.length} metadata objects; they must line up`);
  const keysRaw = jsonish(ctx.values['primaryKeys']);
  const keys = (Array.isArray(keysRaw) ? keysRaw : typeof keysRaw === 'string' && keysRaw ? [keysRaw] : []).map(String);
  const duplicate = str(ctx.values['duplicateOperation']) === 'skip' || str(ctx.values['duplicateOperation']) === 'ignore' ? 'ignore' : 'overwrite';
  const records: RecordInput[] = vectors.map((vector, i) => {
    const meta = metadata[i] ?? {};
    const text = textOf(meta);
    return { id: keys.length ? primaryKeyId(meta, keys, text) : primaryKeyId(meta, [], `${text}\u0000${JSON.stringify(meta)}`), text, metadata: meta, vector };
  });
  const result = store.upsert(collection, records, { duplicate });
  return { recordsIndexed: result.inserted + result.updated, duplicateRecordsDeleted: result.updated, skipped: result.skipped, ids: result.ids, usage, models };
}

const indexFields = [
  f.vectorDB(),
  f.text('vectorsField', 'Vectors', { placeholder: '{{vectorizeNode_1.output.vectors}}', help: 'Leave empty to embed each object automatically.' }),
  f.text('metadataField', 'Objects', { required: true, placeholder: '{{codeNode_1.output.metadata}}', help: 'One object per vector; its content/text field is searchable.' }),
  { key: 'primaryKeys', label: 'Primary keys', type: 'stringList' as const, help: 'Fields that identify an object; re-indexing it overwrites instead of duplicating.' },
  f.select('duplicateOperation', 'On duplicates', [['overwrite', 'Overwrite'], ['skip', 'Skip']]),
  f.embedding(),
];

const indexHandler: NodeHandler = {
  type: 'IndexNode',
  kind: 'action',
  spec: {
    label: 'Index', category: 'rag', icon: 'database', description: 'Store objects and their vectors in a local vector database.',
    fields: indexFields,
    outputs: [{ path: 'recordsIndexed', type: 'number' }, { path: 'duplicateRecordsDeleted', type: 'number' }, { path: 'message', type: 'string' }],
    defaults: () => ({ nodeName: 'Index', vectorDB: '', vectorsField: '', metadataField: '', primaryKeys: [], duplicateOperation: 'overwrite' }),
  },
  sideEffect: () => true,
  idempotent: () => true,
  validate: (node) => [...needsDb(node), ...required(node, 'metadataField')],
  async run(ctx) {
    const collection = collectionName(ctx);
    const r = await indexRecords(ctx, collection);
    return {
      output: { recordsIndexed: r.recordsIndexed, duplicateRecordsDeleted: r.duplicateRecordsDeleted, skipped: r.skipped, ids: r.ids, message: `Indexed ${r.recordsIndexed} record(s) into ${collection}` },
      usage: r.usage, models: r.models,
    };
  },
};

const vectorDbHandler: NodeHandler = {
  type: 'vectorNode',
  kind: 'action',
  spec: {
    label: 'Vector DB', category: 'rag', icon: 'database', description: 'Index, list (filter) or delete objects in a local vector database.',
    fields: [f.select('action', 'Action', [['index', 'Index objects'], ['filter', 'List by filter'], ['delete', 'Delete by filter']]), ...indexFields.map((x) => (x.key === 'vectorDB' ? x : { ...x, showIf: { key: 'action', equals: ['index'] } })),
      f.json('filters', 'Filter', { showIf: { key: 'action', equals: ['filter', 'delete'] } }), f.num('limit', 'Limit', { showIf: { key: 'action', equals: ['filter'] } })],
    outputs: [{ path: 'recordsIndexed', type: 'number' }, { path: 'data', type: 'array' }, { path: 'count', type: 'number' }, { path: 'deletedCount', type: 'number' }],
    defaults: () => ({ nodeName: 'Vector DB', action: 'index', vectorDB: '', metadataField: '', vectorsField: '', primaryKeys: [], duplicateOperation: 'overwrite', filters: '', limit: 20 }),
  },
  sideEffect: (node) => node.values['action'] !== 'filter',
  idempotent: () => true,
  validate: (node) => needsDb(node),
  async run(ctx) {
    const collection = collectionName(ctx);
    const action = str(ctx.values['action']) || 'index';
    const store = vectorStoreOf(ctx);
    if (action === 'index') {
      const r = await indexRecords(ctx, collection);
      return { output: { recordsIndexed: r.recordsIndexed, duplicateRecordsDeleted: r.duplicateRecordsDeleted, ids: r.ids, message: `Indexed ${r.recordsIndexed} record(s)` }, usage: r.usage, models: r.models };
    }
    const filter = parseFilterValue(ctx);
    if (!store.getCollection(collection)) throw new EngineError('NOT_FOUND', `Vector database "${collection}" does not exist`);
    if (action === 'filter') {
      const { records, total } = store.list(collection, { limit: Math.trunc(num(val(ctx, 'limit'), 20)), ...(filter ? { filter } : {}) });
      return { output: { success: true, data: records.map((r) => ({ ...r.metadata, _additional: { id: r.id } })), count: total } };
    }
    if (action === 'delete') {
      if (!filter) throw new EngineError('BAD_PAYLOAD', 'Delete needs a filter; use Context to clear a whole database');
      const matches = store.list(collection, { filter, limit: 1000 }).total;
      const deletedCount = store.delete(collection, { filter });
      return { output: { deletedCount, matches, failed: matches - deletedCount } };
    }
    throw new EngineError('BAD_PAYLOAD', `Unknown action ${action}`);
  },
};

/* ---------------- search ---------------- */

function searchHandler(type: string, label: string, mode: 'vector' | 'hybrid' | 'keyword'): NodeHandler {
  const extra = mode === 'hybrid'
    ? [f.text('alpha', 'Vector weight (alpha, 0–1)'), f.select('fusionType', 'Fusion', [['relativeScoreFusion', 'Relative score'], ['rankedFusion', 'Ranked (RRF)']], { advanced: true })]
    : [];
  return {
    type,
    kind: 'action',
    spec: {
      label, category: 'rag', icon: 'search',
      description: mode === 'vector' ? 'Find the most similar objects by meaning.' : mode === 'hybrid' ? 'Blend semantic and keyword (BM25) relevance.' : 'Find objects by keywords (BM25).',
      fields: [f.text('searchQuery', 'Query', { required: true, placeholder: '{{triggerNode_1.output.searchQuery}}' }), f.vectorDB(), ...(mode !== 'keyword' ? [f.embedding()] : []),
        f.num('limit', 'Results'), ...(mode !== 'keyword' ? [f.text('certainty', 'Minimum certainty (0–1)')] : []), ...extra, f.json('filters', 'Metadata filter', { advanced: true })],
      outputs: [{ path: 'searchResults', type: 'array', description: 'Stored properties plus _additional { certainty, score, id }' }, { path: 'searchResults[:].content', type: 'string[]' }],
      defaults: () => ({ nodeName: label, searchQuery: '', vectorDB: '', limit: 5, ...(mode !== 'keyword' ? { certainty: mode === 'vector' ? '0.5' : '0' } : {}), ...(mode === 'hybrid' ? { alpha: '0.5', fusionType: 'relativeScoreFusion' } : {}), filters: '' }),
    },
    validate: (node) => [...needsDb(node), ...required(node, 'searchQuery')],
    async run(ctx) {
      const r = await retrieve(ctx, {
        collection: collectionName(ctx), query: str(val(ctx, 'searchQuery', '')), mode,
        limit: Math.min(Math.max(Math.trunc(num(val(ctx, 'limit'), 5)), 1), 200),
        ...(mode !== 'keyword' ? { certainty: num(val(ctx, 'certainty'), 0) } : {}),
        ...(mode === 'hybrid' ? { alpha: num(val(ctx, 'alpha'), 0.5), fusion: str(ctx.values['fusionType']) === 'rankedFusion' ? 'ranked' as const : 'relative' as const } : {}),
        filter: parseFilterValue(ctx),
      });
      return { output: { searchResults: r.hits.map(toSearchResult) }, usage: r.usage, models: r.models };
    },
  };
}

/* ---------------- memory ---------------- */

const MEMORY_FACTS_SCHEMA = { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' } } }, required: ['facts'] };

const memoryAddHandler: NodeHandler = {
  type: 'memoryNode',
  kind: 'action',
  spec: {
    label: 'Memory Add', category: 'rag', icon: 'memory',
    description: 'Remember facts from a conversation for a user or session. With a model selected, facts are extracted and de-duplicated.',
    fields: [
      { key: 'memoryCollection', label: 'Memory store', type: 'memoryCollection', required: true },
      f.text('uniqueId', 'User / entity id', { placeholder: '{{triggerNode_1.output.userId}}' }),
      f.text('sessionId', 'Session id', { placeholder: '{{triggerNode_1.output.sessionId}}' }),
      { key: 'memoryValue', label: 'Messages', type: 'prompts', help: 'The exchange to remember.' },
      f.json('metadata', 'Metadata', { advanced: true }),
      f.embedding(), { ...f.model(), help: 'Optional: extract concise facts instead of storing raw messages.' },
    ],
    outputs: [{ path: 'memoryActions', type: 'array' }, { path: 'extractedFacts', type: 'string[]' }],
    defaults: () => ({ nodeName: 'Memory Add', memoryCollection: 'memories', uniqueId: '{{triggerNode_1.output.userId}}', sessionId: '{{triggerNode_1.output.sessionId}}', memoryValue: [{ role: 'user', content: '{{triggerNode_1.output.chatMessage}}' }], metadata: '{}' }),
  },
  sideEffect: () => true,
  idempotent: () => true,
  validate: (node) => required(node, 'memoryCollection', 'memoryValue'),
  async run(ctx) {
    const store = vectorStoreOf(ctx);
    const collection = str(val(ctx, 'memoryCollection'));
    const info = store.ensureCollection(collection, { kind: 'memory' });
    const uniqueId = str(val(ctx, 'uniqueId', '', false));
    const sessionId = str(val(ctx, 'sessionId', '', false));
    const metadata = (jsonField(ctx, 'metadata', {}, false) ?? {}) as Record<string, unknown>;
    const rawMessages = jsonish(resolveValue(ctx.values['memoryValue'] ?? [], ctx.scope, opts(ctx)));
    const messages = (Array.isArray(rawMessages) ? rawMessages : [rawMessages])
      .map((m) => (m && typeof m === 'object' ? { role: str((m as Record<string, unknown>)['role'] || 'user'), content: str((m as Record<string, unknown>)['content']) } : { role: 'user', content: str(m) }))
      .filter((m) => m.content.trim());
    let usage: Partial<Usage> = {};
    const models: string[] = [];
    let facts: string[];
    if (ctx.values['generativeModelName'] !== undefined && ctx.values['generativeModelName'] !== '') {
      const res = await generate(ctx, {
        messages: [
          { role: 'system', content: 'Extract short, self-contained facts worth remembering about the user (preferences, details, plans, decisions). Return JSON {"facts": [...]}; return an empty list when nothing is worth remembering.' },
          { role: 'user', content: messages.map((m) => `${m.role}: ${m.content}`).join('\n') },
        ],
        jsonSchema: MEMORY_FACTS_SCHEMA,
      });
      usage = { llmCalls: 1, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
      models.push(`${res.connectionId}/${res.model}`);
      try {
        const parsed = extractJson(res.text) as { facts?: unknown };
        facts = Array.isArray(parsed.facts) ? parsed.facts.map(str).filter(Boolean) : [];
      } catch {
        throw new EngineError('OUTPUT_SCHEMA', 'Fact extraction did not return JSON', { retryable: true, details: { usage } });
      }
    } else {
      facts = messages.map((m) => (messages.length > 1 ? `${m.role}: ${m.content}` : m.content));
    }
    const actions: { id: string; memory: string; event: 'ADD' | 'NONE' }[] = [];
    if (facts.length) {
      const outcome = await embedTexts(ctx, embeddingRefFor(ctx, info), facts);
      usage = { ...usage, inputTokens: (usage.inputTokens ?? 0) + (outcome.usage.inputTokens ?? 0) };
      models.push(outcome.label);
      rememberEmbedding(store, collection, outcome);
      const scope = uniqueId ? { path: ['uniqueId'], operator: 'Equal', valueText: uniqueId } : undefined;
      const timestamp = new Date().toISOString();
      const records: RecordInput[] = [];
      facts.forEach((fact, i) => {
        const vector = outcome.vectors[i]!;
        const near = store.count(collection) > 0 ? store.search(collection, { mode: 'vector', vector, limit: 1, certainty: 0.985, ...(scope ? { filter: scope } : {}) })[0] : undefined;
        if (near && (near.text.trim().toLowerCase() === fact.trim().toLowerCase() || (near.certainty ?? 0) >= 0.995)) {
          actions.push({ id: near.id, memory: fact, event: 'NONE' });
          return;
        }
        const id = primaryKeyId({ uniqueId, sessionId, fact }, ['uniqueId', 'sessionId', 'fact'], fact);
        records.push({ id, text: fact, vector, metadata: { memory: fact, uniqueId, sessionId, timestamp, metadata } });
        actions.push({ id, memory: fact, event: 'ADD' });
      });
      if (records.length) store.upsert(collection, records);
    }
    return { output: { memoryActions: actions, extractedFacts: facts }, usage, models };
  },
};

const memoryRetrieveHandler: NodeHandler = {
  type: 'memoryRetrieveNode',
  kind: 'action',
  spec: {
    label: 'Memory Retrieve', category: 'rag', icon: 'memory', description: 'Recall the memories most relevant to a query, scoped by user or session filters.',
    fields: [
      { key: 'memoryCollection', label: 'Memory store', type: 'memoryCollection', required: true },
      f.text('searchQuery', 'Query', { placeholder: '{{triggerNode_1.output.chatMessage}}' }), f.num('limit', 'Memories'),
      f.json('filters', 'Filter', { help: 'Paths: uniqueId, sessionId, memory, timestamp, metadata.<field>' }), f.embedding(),
    ],
    outputs: [{ path: 'memories', type: 'string[]' }, { path: 'rawMemories', type: 'array' }],
    defaults: () => ({ nodeName: 'Memory Retrieve', memoryCollection: 'memories', searchQuery: '{{triggerNode_1.output.chatMessage}}', limit: 5, filters: '{"operator":"And","operands":[{"path":["uniqueId"],"operator":"Equal","valueText":"{{triggerNode_1.output.userId}}"}]}' }),
  },
  validate: (node) => required(node, 'memoryCollection'),
  async run(ctx) {
    const store = vectorStoreOf(ctx);
    const collection = str(val(ctx, 'memoryCollection'));
    const limit = Math.min(Math.max(Math.trunc(num(val(ctx, 'limit'), 5)), 1), 100);
    const filter = parseFilterValue(ctx);
    if (!store.getCollection(collection)) return { output: { memories: [], rawMemories: [] } };
    const query = str(val(ctx, 'searchQuery', '', false));
    let raw: Record<string, unknown>[];
    let usage: Partial<Usage> = {};
    let models: string[] = [];
    if (query.trim()) {
      const r = await retrieve(ctx, { collection, query, mode: 'vector', limit, filter });
      usage = r.usage;
      models = r.models;
      raw = r.hits.map((h) => ({ id: h.id, memory: h.text, score: h.score, ...h.metadata }));
    } else {
      // No query: the most recent memories, newest first (the store applies the limit after filtering).
      const { records } = store.list(collection, { limit, order: 'newest', ...(filter ? { filter } : {}) });
      raw = records.map((r) => ({ id: r.id, memory: r.text, ...r.metadata }));
    }
    return { output: { memories: raw.map((m) => str(m['memory'])), rawMemories: raw }, usage, models };
  },
};

/* ---------------- files ---------------- */

const extractHandler: NodeHandler = {
  type: 'extractFromFileNode',
  kind: 'action',
  spec: {
    label: 'Extract from File', category: 'data', icon: 'file',
    description: 'Read text from PDF, Word, PowerPoint, Excel, HTML, Markdown, CSV or JSON files (URLs, data URLs or uploads).',
    fields: [
      f.text('fileUrl', 'File URL', { required: true, placeholder: '{{triggerNode_1.output.fileUrl}}' }),
      f.select('format', 'Format', ['auto', 'pdf', 'docx', 'pptx', 'xlsx', 'html', 'markdown', 'text', 'csv', 'json']),
      f.bool('joinPages', 'Join pages into one text'),
      f.text('delimiter', 'CSV delimiter', { advanced: true, showIf: { key: 'format', equals: ['csv', 'auto'] } }),
      f.bool('headers', 'CSV has a header row', { advanced: true, showIf: { key: 'format', equals: ['csv', 'auto'] } }),
      f.num('skipRows', 'CSV rows to skip', { advanced: true, showIf: { key: 'format', equals: ['csv', 'auto'] } }),
      f.num('maxRows', 'CSV max rows', { advanced: true, showIf: { key: 'format', equals: ['csv', 'auto'] } }),
    ],
    outputs: [{ path: 'files', type: 'array', description: '[{ fileName, format, data: [page text… | rows…] }]' }, { path: 'files[0].data', type: 'array' }, { path: 'text', type: 'string' }],
    defaults: () => ({ nodeName: 'Extract from File', fileUrl: '', format: 'auto', joinPages: false, headers: true }),
  },
  validate: (node) => required(node, 'fileUrl'),
  async run(ctx) {
    const raw = jsonish(val(ctx, 'fileUrl', ''));
    const urls = (Array.isArray(raw) ? raw : [raw]).map((u) => (u && typeof u === 'object' ? str((u as Record<string, unknown>)['url'] ?? (u as Record<string, unknown>)['fileUrl']) : str(u))).filter(Boolean);
    const join = bool(ctx.values['joinPages']);
    const files = [];
    for (const url of urls) {
      const file = await loadFile(url, ctx);
      let doc;
      try {
        doc = extractDocument(file.bytes, {
          filename: file.name, mime: file.mime, format: str(ctx.values['format']) || 'auto',
          csv: {
            ...(str(ctx.values['delimiter']) ? { delimiter: str(ctx.values['delimiter']) } : {}),
            headers: bool(ctx.values['headers'], true),
            skipRows: Math.trunc(num(ctx.values['skipRows'], 0)), ...(num(ctx.values['maxRows'], 0) > 0 ? { maxRows: Math.trunc(num(ctx.values['maxRows'], 0)) } : {}),
          },
        });
      } catch (e) {
        throw new EngineError('BAD_PAYLOAD', `Could not read ${file.name}: ${(e as Error).message}`);
      }
      const data = doc.rows && (doc.format === 'csv' || doc.format === 'xlsx') ? doc.rows : join ? [doc.pages.join('\n\n')] : doc.pages;
      files.push({ fileName: file.name, format: doc.format, mimeType: file.mime, data, pages: doc.pages.length, ...(doc.title ? { title: doc.title } : {}) });
    }
    const text = files.map((x) => (x.format === 'csv' || x.format === 'xlsx' ? JSON.stringify(x.data) : (x.data as string[]).join('\n\n'))).join('\n\n');
    return { output: { files, text } };
  },
};

export const ragHandlers: NodeHandler[] = [
  chunkHandler, vectorizeHandler, indexHandler, vectorDbHandler,
  searchHandler('searchNode', 'Vector Search', 'vector'),
  searchHandler('hybridSearchNode', 'Hybrid Search', 'hybrid'),
  searchHandler('fullTextSearchNode', 'Keyword Search', 'keyword'),
  memoryAddHandler, memoryRetrieveHandler, extractHandler,
];
