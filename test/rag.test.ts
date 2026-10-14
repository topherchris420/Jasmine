import { describe, expect, it } from 'vitest';
import { JasmineDb } from '../src/db/database.ts';
import { lexicalEmbedding, MockLLMProvider } from '../src/llm/providers.ts';
import { chunkText } from '../src/vector/chunking.ts';
import { extractDocument, htmlToText, parseCsv } from '../src/vector/extract.ts';
import { matchesFilter, parseFilter } from '../src/vector/filters.ts';
import { extractPdfPages } from '../src/vector/pdf.ts';
import { VectorStore } from '../src/vector/store.ts';
import { docx, pdf, pptx } from './fixtures.ts';
import { createTestApp } from './helpers.ts';

const DOCS = [
  { id: 'reset', text: 'To reset your password open Settings, choose Security and click Reset password.', metadata: { title: 'Passwords', category: 'account', year: 2024 } },
  { id: 'refund', text: 'Refunds are issued within 14 days to the original payment method.', metadata: { title: 'Refunds', category: 'billing', year: 2023 } },
  { id: 'export', text: 'You can export all reports as CSV files from the Reports page.', metadata: { title: 'Exports', category: 'reports', year: 2024, tags: ['csv', 'data'] } },
];

function store() {
  const s = new VectorStore(JasmineDb.memory());
  s.createCollection({ name: 'kb' });
  s.upsert('kb', DOCS.map((d) => ({ ...d, vector: lexicalEmbedding(d.text) })));
  return s;
}

describe('vector store', () => {
  it('ranks by cosine similarity, applies certainty thresholds and reports Weaviate-style certainty', () => {
    const s = store();
    const hits = s.search('kb', { mode: 'vector', vector: lexicalEmbedding('how do I reset my password'), limit: 2 });
    expect(hits[0]!.id).toBe('reset');
    expect(hits[0]!.certainty).toBeGreaterThan(0.5);
    expect(hits[0]!.certainty).toBeCloseTo((1 + hits[0]!.vectorScore!) / 2, 5);
    expect(s.search('kb', { mode: 'vector', vector: lexicalEmbedding('how do I reset my password'), certainty: 0.999 })).toEqual([]);
  });

  it('does BM25 keyword search and hybrid fusion, both filterable', () => {
    const s = store();
    expect(s.search('kb', { mode: 'keyword', query: 'refund payment' })[0]!.id).toBe('refund');
    const hybrid = s.search('kb', { mode: 'hybrid', query: 'csv export', vector: lexicalEmbedding('download reports'), alpha: 0.5, limit: 3 });
    expect(hybrid[0]!.id).toBe('export');
    expect(hybrid[0]).toHaveProperty('keywordScore');
    const ranked = s.search('kb', { mode: 'hybrid', query: 'csv export', vector: lexicalEmbedding('download reports'), fusion: 'ranked' });
    expect(ranked[0]!.id).toBe('export');
    const filtered = s.search('kb', { mode: 'vector', vector: lexicalEmbedding('password reset'), filter: { path: ['category'], operator: 'Equal', valueText: 'billing' } });
    expect(filtered.map((h) => h.id)).toEqual(['refund']);
    expect(s.search('kb', { mode: 'keyword', query: 'reports', filter: { year: 2023 } })).toEqual([]);
  });

  it('enforces one embedding dimension per collection and handles duplicates, listing and deletion', () => {
    const s = store();
    expect(() => s.upsert('kb', [{ text: 'x', vector: [1, 2, 3] }])).toThrow(/384-dimensional/);
    expect(() => s.search('kb', { mode: 'vector', vector: [1, 0] })).toThrow(/dimensions/);
    expect(s.upsert('kb', [{ id: 'reset', text: 'changed', vector: lexicalEmbedding('changed') }], { duplicate: 'ignore' })).toMatchObject({ skipped: 1, inserted: 0 });
    expect(s.get('kb', 'reset')!.text).toContain('reset your password');
    expect(s.upsert('kb', [{ id: 'reset', text: 'changed', vector: lexicalEmbedding('changed') }])).toMatchObject({ updated: 1 });
    expect(s.search('kb', { mode: 'keyword', query: 'changed' })[0]!.id).toBe('reset');
    expect(s.list('kb', { filter: { path: ['tags'], operator: 'ContainsAny', valueTextArray: ['csv'] } }).total).toBe(1);
    expect(s.delete('kb', { filter: { path: ['year'], operator: 'LessThan', valueInt: 2024 } })).toBe(1);
    expect(s.count('kb')).toBe(2);
    expect(s.clear('kb')).toBe(2);
    expect(s.getCollection('kb')!.dimension).toBeNull();
    expect(() => s.search('missing', { mode: 'keyword', query: 'x' })).toThrow(/does not exist/);
  });

  it('parses Weaviate where-filters, JSON strings and shorthand maps', () => {
    const meta = { uniqueId: 'u1', score: 7, title: 'Hello World', nested: { a: 1 } };
    expect(matchesFilter(meta, parseFilter('{"operator":"And","operands":[{"path":["uniqueId"],"operator":"Equal","valueText":"u1"},{"path":["score"],"operator":"GreaterThanEqual","valueInt":7}]}'))).toBe(true);
    expect(matchesFilter(meta, parseFilter({ operator: 'Or', operands: [{ path: 'title', operator: 'Like', valueText: 'hello*' }, { path: ['score'], operator: 'LessThan', valueInt: 1 }] }))).toBe(true);
    expect(matchesFilter(meta, parseFilter({ 'nested.a': 1 }))).toBe(true);
    expect(parseFilter('')).toBeUndefined();
    expect(parseFilter('[]')).toBeUndefined();
    expect(() => parseFilter({ path: ['x'], operator: 'Nope' })).toThrow(/Unknown filter operator/);
  });
});

describe('chunking and extraction', () => {
  it('splits on natural boundaries within the size limit, with overlap', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkText(text, { chunkSize: 120, chunkOverlap: 30 });
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 120)).toBe(true);
    // With 30 characters of overlap, each chunk starts with the last sentence of the previous one.
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.startsWith(chunks[i - 1]!.split('. ').at(-1)!)).toBe(true);
    expect(chunkText('# A\n\nalpha\n\n# B\n\nbeta', { chunkSize: 12, chunkOverlap: 0, strategy: 'markdown' })).toEqual(['# A\n\nalpha', '# B\n\nbeta']);
    expect(chunkText('   ')).toEqual([]);
    expect(chunkText('x'.repeat(250), { chunkSize: 100, chunkOverlap: 10 }).every((c) => c.length <= 100)).toBe(true);
  });

  it('reads PDFs with compressed streams, object streams and ToUnicode fonts', () => {
    const pages = extractPdfPages(pdf('Hello (simple) world', 'Unicode café'));
    expect(pages[0]).toBe('Hello (simple) world');
    expect(pages[1]).toContain('Unicode café');
    // The TJ array splits after two glyphs with a -300 kern, which reads as a word gap.
    expect(pages[1]!.split('\n')[1]).toBe('Un icode café');
  });

  it('reads Word, PowerPoint, HTML, CSV and JSON', () => {
    expect(extractDocument(docx(['First paragraph.', 'Second & last.']), { filename: 'a.docx' })).toEqual({ format: 'docx', pages: ['First paragraph.\nSecond & last.'] });
    expect(extractDocument(pptx(['Slide one', 'Slide two']), { filename: 'deck.pptx' }).pages).toEqual(['Slide one', 'Slide two']);
    const html = extractDocument(Buffer.from('<html><head><title>T &amp; C</title><style>x{}</style></head><body><nav>menu</nav><h1>Terms</h1><p>Read <b>carefully</b>.</p><ul><li>One</li></ul><script>evil()</script></body></html>'));
    expect(html.title).toBe('T & C');
    expect(html.pages[0]).toBe('# Terms\n\nRead carefully.\n\n- One');
    expect(parseCsv('name,age\n"Doe, Jane",31\n\nBob,40\n', {})).toEqual([{ name: 'Doe, Jane', age: '31' }, { name: 'Bob', age: '40' }]);
    expect(extractDocument(Buffer.from('{"a":1}'), { filename: 'x.json' }).pages[0]).toBe('{\n  "a": 1\n}');
    expect(htmlToText('a&nbsp;b &#x41; &#66;')).toBe('a b A B');
  });
});

describe('knowledge bases and RAG nodes', () => {
  it('ingests text and files, answers with references, and cleans up documents', async () => {
    const llm = new MockLLMProvider({ respond: (req) => `Answer from: ${req.messages.at(-1)!.content.includes('Reset password') ? 'passwords doc' : 'nothing'}` });
    const t = await createTestApp({ llm });
    try {
      const { app } = t;
      app.vectors.createCollection({ name: 'handbook', embeddingConnection: 'builtin' });
      const text = app.knowledge.ingest({ collection: 'handbook', type: 'text', title: 'Account help', text: DOCS.map((d) => d.text).join('\n\n'), chunkSize: 100, chunkOverlap: 0 });
      expect((await app.knowledge.wait(text.id))).toMatchObject({ status: 'ready', chunks: 3 });
      const file = app.files.save(pdf('Shipping takes three business days.', 'Returns accepted'), 'policy.pdf', 'application/pdf');
      const doc = app.knowledge.ingest({ collection: 'handbook', type: 'file', fileId: file.id });
      expect(await app.knowledge.wait(doc.id)).toMatchObject({ status: 'ready', chunks: 2, title: 'policy.pdf' });
      const info = app.vectors.getCollection('handbook')!;
      expect(info).toMatchObject({ records: 5, documents: 2, embeddingConnection: 'builtin', dimension: 384 });
      expect(app.vectors.list('handbook', { documentId: doc.id }).records.map((r) => r.metadata['page'])).toEqual([1, 2]);

      const template = (await app.templates()).find((x) => x.id === 'knowledge-qa')!;
      await app.workspace.save('qa', 'QA', template.definition);
      await app.deployFlow('qa');
      const res = await app.runs.executeWorkflow('qa', { question: 'How can I reset my password?' });
      expect(res.status).toBe('success');
      expect(res.output).toMatchObject({ answer: 'Answer from: passwords doc', sources: expect.arrayContaining(['Account help']) });
      const ragNode = res.nodes!.find((n) => n.nodeType === 'RAGNode');
      expect(ragNode?.status).toBe('success');

      const failing = app.knowledge.ingest({ collection: 'handbook', type: 'file', fileId: app.files.save(Buffer.from('PK\x03\x04 not really a zip'), 'broken.docx', 'application/octet-stream').id });
      expect(await app.knowledge.wait(failing.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('ZIP') });
      expect(app.knowledge.remove(doc.id)).toBe(true);
      expect(app.vectors.getCollection('handbook')!.records).toBe(3);

      // Removing a document while it is still processing stops the job before it writes any chunks.
      const recordsBefore = app.vectors.getCollection('handbook')!.records;
      const doomed = app.knowledge.ingest({ collection: 'handbook', type: 'text', title: 'Doomed', text: 'This text must never be indexed.' });
      expect(app.knowledge.remove(doomed.id)).toBe(true);
      await app.knowledge.wait(doomed.id).catch(() => {});
      expect(app.vectors.getCollection('handbook')!.records).toBe(recordsBefore);
      expect(app.vectors.list('handbook', { documentId: doomed.id }).records).toEqual([]);

      // API callers may omit `type`: it is inferred from the source field, and a request without one is rejected.
      const inferred = app.knowledge.ingest({ collection: 'handbook', title: 'Note', text: 'Offices close at 6pm on Fridays.' });
      expect(inferred).toMatchObject({ source: 'text', mime: 'text/plain' });
      expect(await app.knowledge.wait(inferred.id)).toMatchObject({ status: 'ready' });
      expect(() => app.knowledge.ingest({ collection: 'handbook', title: 'Nothing' })).toThrow(/fileId, text, url/);
    } finally {
      await t.close();
    }
  });

  it('runs the Jasmine indexing pipeline: chunk → vectorize → code → Index → Vector Search', async () => {
    const t = await createTestApp();
    try {
      const { app } = t;
      const flow = {
        nodes: [
          { id: 'triggerNode_1', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
          { id: 'chunkNode_1', data: { nodeId: 'chunkNode', values: { chunkField: '{{triggerNode_1.output.text}}', numOfChars: 40, overlapChars: 0 } } },
          { id: 'vectorizeNode_1', data: { nodeId: 'vectorizeNode', values: { inputText: '{{chunkNode_1.output.chunks[:].pageContent}}', embeddingModelName: { connection: 'builtin' } } } },
          { id: 'codeNode_1', data: { nodeId: 'codeNode', values: { code: 'const c = {{chunkNode_1.output.chunks}};\noutput = { vectors: {{vectorizeNode_1.output.vectors}}, metadata: c.map((x, i) => ({ content: x.pageContent, title: "doc", n: i })) };' } } },
          { id: 'IndexNode_1', data: { nodeId: 'IndexNode', values: { vectorDB: ['facts'], vectorsField: '{{codeNode_1.output.vectors}}', metadataField: '{{codeNode_1.output.metadata}}', primaryKeys: '["title","n"]', duplicateOperation: 'overwrite', embeddingModelName: { connection: 'builtin' } } } },
          { id: 'searchNode_1', data: { nodeId: 'searchNode', values: { searchQuery: '{{triggerNode_1.output.q}}', vectorDB: 'facts', limit: 1, certainty: '0.1' } } },
          { id: 'responseNode_1', type: 'responseNode', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"indexed": "{{IndexNode_1.output.recordsIndexed}}", "top": "{{searchNode_1.output.searchResults[0].content}}", "certainty": "{{searchNode_1.output.searchResults[0]._additional.certainty}}"}' } } },
        ],
        edges: [['triggerNode_1', 'chunkNode_1'], ['chunkNode_1', 'vectorizeNode_1'], ['vectorizeNode_1', 'codeNode_1'], ['codeNode_1', 'IndexNode_1'], ['IndexNode_1', 'searchNode_1'], ['searchNode_1', 'responseNode_1']].map(([source, target]) => ({ source, target })),
      };
      await app.deployments.deploy('index', flow);
      const text = 'Mars is the fourth planet from the Sun.\n\nJupiter is the largest planet.\n\nSaturn has prominent rings.';
      const first = await app.runs.executeWorkflow('index', { text, q: 'Which planet has rings?' });
      expect(first.error).toBeUndefined();
      expect(first.output).toMatchObject({ indexed: 3, top: 'Saturn has prominent rings.' });
      expect((first.output as { certainty: number }).certainty).toBeGreaterThan(0.5);
      await app.runs.executeWorkflow('index', { text, q: 'largest' });
      expect(app.vectors.count('facts')).toBe(3);
      expect(app.vectors.getCollection('facts')).toMatchObject({ embeddingConnection: 'builtin', embeddingModel: 'jasmine-lexical-384' });
    } finally {
      await t.close();
    }
  });

  it('stores and recalls memories per user, skipping duplicates', async () => {
    const t = await createTestApp();
    try {
      const { app } = t;
      app.vectors.createCollection({ name: 'mem', kind: 'memory', embeddingConnection: 'builtin' });
      const flow = {
        nodes: [
          { id: 't', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
          { id: 'recall', data: { nodeId: 'memoryRetrieveNode', values: { memoryCollection: 'mem', searchQuery: '{{t.output.q}}', limit: 3, filters: '{"operator":"And","operands":[{"path":["uniqueId"],"operator":"Equal","valueText":"{{t.output.user}}"}]}' } } },
          { id: 'add', data: { nodeId: 'memoryNode', values: { memoryCollection: 'mem', uniqueId: '{{t.output.user}}', sessionId: 's1', memoryValue: [{ role: 'user', content: '{{t.output.say}}' }], metadata: '{"source": "test"}' } } },
          { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"recalled": "{{recall.output.memories}}", "actions": "{{add.output.memoryActions[:].event}}"}' } } },
        ],
        edges: [{ source: 't', target: 'recall' }, { source: 'recall', target: 'add' }, { source: 'add', target: 'r' }],
      };
      await app.deployments.deploy('mem', flow);
      const run = (user: string, say: string, q: string) => app.runs.executeWorkflow('mem', { user, say, q });
      expect((await run('alice', 'My favourite colour is green', 'colour')).output).toEqual({ recalled: [], actions: ['ADD'] });
      expect((await run('alice', 'My favourite colour is green', 'favourite colour')).output).toEqual({ recalled: ['My favourite colour is green'], actions: ['NONE'] });
      expect((await run('bob', 'I live in Lisbon', 'favourite colour')).output).toEqual({ recalled: [], actions: ['ADD'] });
      expect(app.vectors.list('mem').records.map((r) => r.metadata['uniqueId']).sort()).toEqual(['alice', 'bob']);
    } finally {
      await t.close();
    }
  });

  it('extracts files through the Extract node from data URLs and uploads', async () => {
    const t = await createTestApp();
    try {
      const { app } = t;
      const upload = app.files.save(docx(['Quarterly plan', 'Ship v2']), 'plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      await app.deployments.deploy('extract', {
        nodes: [
          { id: 't', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
          { id: 'x', data: { nodeId: 'extractFromFileNode', values: { fileUrl: '{{t.output.files}}', format: 'auto' } } },
          { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"names": "{{x.output.files[:].fileName}}", "first": "{{x.output.files[0].data[0]}}", "rows": "{{x.output.files[1].data}}"}' } } },
        ],
        edges: [{ source: 't', target: 'x' }, { source: 'x', target: 'r' }],
      });
      const csv = `data:text/csv;base64,${Buffer.from('a,b\n1,2').toString('base64')}`;
      const res = await app.runs.executeWorkflow('extract', { files: [upload.url, csv] });
      expect(res.output).toEqual({ names: ['plan.docx', 'inline'], first: 'Quarterly plan\nShip v2', rows: [{ a: '1', b: '2' }] });
    } finally {
      await t.close();
    }
  });
});
