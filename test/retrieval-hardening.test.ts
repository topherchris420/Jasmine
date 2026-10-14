import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dropKeywordIndex, JasmineDb, keywordIndexName } from '../src/db/database.ts';
import { compileFlow } from '../src/flow/compile.ts';
import { MockLLMProvider, StaticLLMRouter } from '../src/llm/providers.ts';
import { defaultRegistry } from '../src/nodes/builtin.ts';
import { executePlan } from '../src/runtime/executor.ts';
import { RunService } from '../src/service/runs.ts';
import { VectorStore } from '../src/vector/store.ts';
import { createTestApp, edge, response, trigger } from './helpers.ts';

const keyword = (s: VectorStore, collection: string, query: string, limit = 2) =>
  s.search(collection, { mode: 'keyword', query, limit }).map((h) => [h.id, h.score]);

function compile(def: unknown) {
  const compiled = compileFlow(def, defaultRegistry());
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.plan;
}

const services = (store: VectorStore, llm = new MockLLMProvider()) => ({ llm: new StaticLLMRouter({ mock: llm }, 'mock', 'mock-model'), fetch, codeTimeoutMs: 1000, vectors: store });

/** The shared keyword index and triggers exactly as migration 1 created them (before per-collection indexes). */
const LEGACY_FTS = `
  CREATE VIRTUAL TABLE vector_fts USING fts5 (text, content = 'vector_records', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER vector_records_ai AFTER INSERT ON vector_records BEGIN
    INSERT INTO vector_fts (rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER vector_records_ad AFTER DELETE ON vector_records BEGIN
    INSERT INTO vector_fts (vector_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER vector_records_au AFTER UPDATE ON vector_records BEGIN
    INSERT INTO vector_fts (vector_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO vector_fts (rowid, text) VALUES (new.rowid, new.text);
  END;`;

describe('keyword (BM25) ranking per collection', () => {
  it('does not change when another collection is written to', () => {
    const s = new VectorStore(JasmineDb.memory());
    s.createCollection({ name: 'kb' });
    s.upsert('kb', [
      { id: 'A', text: 'refund policy refund policy refund details' },
      { id: 'B', text: 'shipping policy and warranty terms overview' },
      { id: 'C', text: 'office opening hours' },
    ]);
    const before = keyword(s, 'kb', 'refund warranty', 3);
    expect(before.map(([id]) => id)).toEqual(['A', 'B']);
    s.createCollection({ name: 'other' });
    s.upsert('other', Array.from({ length: 200 }, (_, i) => ({ id: `o${i}`, text: `refund request number ${i}` })));
    expect(keyword(s, 'kb', 'refund warranty', 3)).toEqual(before);
    s.delete('other', { ids: ['o1', 'o2'] });
    s.clear('other');
    expect(keyword(s, 'kb', 'refund warranty', 3)).toEqual(before);
    // Hybrid search fuses the same per-collection keyword scores.
    expect(s.search('kb', { mode: 'hybrid', query: 'refund warranty', vector: [1, 0], alpha: 0, limit: 3 }).map((h) => [h.id, h.keywordScore])).toEqual(before);
  });

  it('keeps each index in step with writes and drops it with its collection', () => {
    const db = JasmineDb.memory();
    const s = new VectorStore(db);
    s.createCollection({ name: 'kb' });
    s.upsert('kb', [{ id: 'a', text: 'alpha beta' }, { id: 'b', text: 'gamma' }]);
    s.upsert('kb', [{ id: 'a', text: 'delta' }]);
    expect(keyword(s, 'kb', 'alpha')).toEqual([]);
    expect(keyword(s, 'kb', 'delta').map(([id]) => id)).toEqual(['a']);
    s.delete('kb', { ids: ['b'] });
    expect(keyword(s, 'kb', 'gamma')).toEqual([]);
    const t = keywordIndexName('kb');
    db.run(`INSERT INTO ${t} (${t}, rank) VALUES ('integrity-check', 1)`);
    s.deleteCollection('kb');
    expect(db.all("SELECT name FROM sqlite_master WHERE name LIKE ?", `${t}%`)).toEqual([]);
    s.createCollection({ name: 'kb' });
    expect(keyword(s, 'kb', 'delta')).toEqual([]);
  });

  it('with a metadata filter, finds matches however far down the ranking they are', () => {
    const s = new VectorStore(JasmineDb.memory());
    s.createCollection({ name: 'kb' });
    s.upsert('kb', [
      ...Array.from({ length: 150 }, (_, i) => ({ id: `n${i}`, text: 'invoice invoice invoice', metadata: { team: 'billing' } })),
      { id: 'wanted', text: 'invoice and many other words that dilute the match a lot', metadata: { team: 'legal' } },
    ]);
    expect(s.search('kb', { mode: 'keyword', query: 'invoice', limit: 1, filter: { team: 'legal' } }).map((h) => h.id)).toEqual(['wanted']);
  });

  it.each(['v2', 'v3'])('upgrades a %s workspace: existing records are reindexed per collection', async (from) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jasmine-fts-upgrade-'));
    const file = path.join(dir, 'jasmine.db');
    try {
      // Build the pre-upgrade schema: shared vector_fts and its triggers, no migration 4 (nor 3 for v2).
      let db = new JasmineDb(file);
      const now = new Date().toISOString();
      for (const name of ['kb', 'other']) {
        db.run('INSERT INTO vector_collections (name, created_at, updated_at) VALUES (?, ?, ?)', name, now, now);
        dropKeywordIndex(db, name);
      }
      db.sqlite.exec(LEGACY_FTS);
      db.run('DELETE FROM schema_migrations WHERE version >= ?', from === 'v2' ? 3 : 4);
      if (from === 'v2') for (const table of ['execution_keys', 'execution_state', 'response_cache', 'run_feedback', 'oauth_states']) db.sqlite.exec(`DROP TABLE ${table}`);
      const insert = (collection: string, id: string, text: string) => db.run('INSERT INTO vector_records (collection, id, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', collection, id, text, now, now);
      insert('kb', 'A', 'refund policy refund policy refund details');
      insert('kb', 'B', 'shipping policy and warranty terms overview');
      for (let i = 0; i < 50; i++) insert('other', `o${i}`, `refund request number ${i}`);
      expect(db.get<{ n: number }>("SELECT count(*) AS n FROM vector_fts WHERE vector_fts MATCH 'refund'")!.n).toBe(51);
      db.close();

      db = new JasmineDb(file);
      try {
        expect(db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version)).toEqual([1, 2, 3, 4]);
        expect(db.all("SELECT name FROM sqlite_master WHERE name IN ('vector_fts', 'vector_records_ai', 'vector_records_ad', 'vector_records_au')")).toEqual([]);
        const s = new VectorStore(db);
        const fresh = new VectorStore(JasmineDb.memory());
        fresh.createCollection({ name: 'kb' });
        fresh.upsert('kb', [{ id: 'A', text: 'refund policy refund policy refund details' }, { id: 'B', text: 'shipping policy and warranty terms overview' }]);
        expect(keyword(s, 'kb', 'refund warranty')).toEqual(keyword(fresh, 'kb', 'refund warranty'));
        expect(keyword(s, 'other', 'number 7', 1).map(([id]) => id)).toEqual(['o7']);
        s.upsert('kb', [{ id: 'C', text: 'extended warranty' }]);
        expect(keyword(s, 'kb', 'extended').map(([id]) => id)).toEqual(['C']);
        const t = keywordIndexName('kb');
        db.run(`INSERT INTO ${t} (${t}, rank) VALUES ('integrity-check', 1)`);
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('memory recall without a query', () => {
  it('returns the newest memories first, however many are stored', async () => {
    const store = new VectorStore(JasmineDb.memory());
    store.createCollection({ name: 'mem', kind: 'memory' });
    store.upsert('mem', Array.from({ length: 1005 }, (_, i) => ({ id: `m${i}`, text: `fact #${i}`, metadata: { memory: `fact #${i}`, uniqueId: i % 2 ? 'odd' : 'even' } })));
    const recall = async (filters: string) => {
      const plan = compile({ id: 'f', nodes: [
        { id: 'trigger', type: 'graphqlNode', trigger: true },
        { id: 'recall', type: 'memoryRetrieveNode', values: { memoryCollection: 'mem', searchQuery: '', limit: 3, filters } },
        { id: 'response', type: 'graphqlResponseNode', values: { outputMapping: '{"m":"{{recall.output.memories}}"}' } },
      ], edges: [{ source: 'trigger', target: 'recall' }, { source: 'recall', target: 'response' }] });
      const r = await executePlan(plan, { payload: {}, services: services(store) });
      return (r.output as { m: string[] }).m;
    };
    expect(await recall('')).toEqual(['fact #1004', 'fact #1003', 'fact #1002']);
    expect(await recall('{"path":["uniqueId"],"operator":"Equal","valueText":"odd"}')).toEqual(['fact #1003', 'fact #1001', 'fact #999']);
  });
});

describe('RAG prompt template', () => {
  it('keeps $ sequences from documents and the question literal, and expands placeholders once', async () => {
    const store = new VectorStore(JasmineDb.memory());
    store.createCollection({ name: 'kb' });
    const content = "Energy: $$E = mc^2$$ (costs $&5, $1 or $')";
    store.upsert('kb', [{ id: 'd1', text: content, metadata: { content } }]);
    const llm = new MockLLMProvider();
    const plan = compile({ id: 'f', nodes: [
      { id: 'trigger', type: 'graphqlNode', trigger: true },
      { id: 'rag', type: 'RAGNode', values: { queryField: '{{trigger.output.q}}', vectorDB: 'kb', searchType: 'keyword' } },
      { id: 'response', type: 'graphqlResponseNode', values: { outputMapping: '{"a":"{{rag.output.modelResponse}}"}' } },
    ], edges: [{ source: 'trigger', target: 'rag' }, { source: 'rag', target: 'response' }] });
    const question = "energy: what is $' and $$ here, not {context}?";
    const r = await executePlan(plan, { payload: { q: question }, services: services(store, llm) });
    expect(r.status).toBe('success');
    expect(llm.requests[0]!.messages.at(-1)!.content).toBe(`Documents:\n[1] ${content}\n\nQuestion: ${question}`);
  });
});

describe('run service idempotency index', () => {
  it('stays bounded by retained runs while keys still resolve through the durable store', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('e', { nodes: [trigger(), response('{"v":"{{trigger.output.v}}"}')], edges: [edge('trigger', 'response')] });
      const runs = new RunService(t.app.deployments, { services: t.app.runs.services, state: t.app.executionState, retainRuns: 3 });
      const index = (runs as unknown as { idempotency: Map<string, unknown> }).idempotency;
      const first = await runs.executeWorkflow('e', { v: 0 }, { idempotencyKey: 'k0' });
      for (let i = 1; i < 12; i++) await runs.executeWorkflow('e', { v: i }, { idempotencyKey: `k${i}` });
      expect(index.size).toBeLessThanOrEqual(3);
      // An evicted key is still answered by the durable binding, with the original run.
      const again = await runs.executeWorkflow('e', { v: 0 }, { idempotencyKey: 'k0' });
      expect(again).toMatchObject({ requestId: first.requestId, output: { v: 0 } });
      await expect(runs.executeWorkflow('e', { v: 99 }, { idempotencyKey: 'k0' })).rejects.toMatchObject({ code: 'CONFLICT' });
      // A retained key resolves from memory.
      expect((await runs.executeWorkflow('e', { v: 11 }, { idempotencyKey: 'k11' })).output).toEqual({ v: 11 });
    } finally {
      await t.close();
    }
  });

  it('sweeps expired keys', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('e', { nodes: [trigger(), response('{"v":"{{trigger.output.v}}"}')], edges: [edge('trigger', 'response')] });
      const runs = new RunService(t.app.deployments, { services: t.app.runs.services, idempotencyTtlMs: 1_000 });
      const internals = runs as unknown as { idempotency: Map<string, unknown>; sweepIdempotency(now: number): void };
      for (let i = 0; i < 5; i++) await runs.executeWorkflow('e', { v: i }, { idempotencyKey: `k${i}` });
      expect(internals.idempotency.size).toBe(5);
      internals.sweepIdempotency(Date.now() + 120_000);
      expect(internals.idempotency.size).toBe(0);
    } finally {
      await t.close();
    }
  });
});
