import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Jasmine } from '../src/app.ts';
import { SecretBox } from '../src/db/secrets.ts';
import { numberSqliteParameters, TablesStore } from '../src/integrations/tables.ts';
import { createTestApp } from './helpers.ts';

const truncateTag = (sealed: string, bytes: number) => {
  const [iv, tag, body] = sealed.slice('enc:v1:'.length).split(':');
  return `enc:v1:${iv}:${Buffer.from(tag!, 'base64').subarray(0, bytes).toString('base64')}:${body}`;
};

describe('SecretBox', () => {
  it('accepts only full 128-bit GCM tags', () => {
    const box = SecretBox.ephemeral();
    const sealed = box.sealJson({ id: 'abc', expiresAt: 1 });
    expect(box.openJson(sealed)).toEqual({ id: 'abc', expiresAt: 1 });
    for (const n of [15, 12, 8, 4]) expect(() => box.open(truncateTag(sealed, n)), `${n}-byte tag`).toThrow();
    const [iv, ...rest] = sealed.slice('enc:v1:'.length).split(':');
    expect(() => box.open(`enc:v1:${Buffer.from(iv!, 'base64').subarray(0, 8).toString('base64')}:${rest.join(':')}`)).toThrow(/Malformed/);
  });

  it('rejects file links whose token tag was truncated', async () => {
    const t = await createTestApp();
    try {
      const saved = t.app.files.save(Buffer.from('secret'), 'a.txt', 'text/plain');
      const token = new URL(t.app.fileUrl(saved.id)).searchParams.get('token')!;
      expect(t.app.verifyFileToken(saved.id, token)).toBe(true);
      const short = Buffer.from(truncateTag(Buffer.from(token, 'base64url').toString(), 4)).toString('base64url');
      expect(t.app.verifyFileToken(saved.id, short)).toBe(false);
    } finally {
      await t.close();
    }
  });
});

describe.skipIf(process.platform === 'win32')('data directory permissions', () => {
  it('creates an owner-only data directory and database files, and tightens existing ones', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'jasmine-perm-'));
    const mode = (f: string) => statSync(f).mode & 0o777;
    try {
      const fresh = path.join(root, 'fresh');
      const app = await Jasmine.create({ dataDir: fresh, env: { LLM_PROVIDER: 'mock' }, probeModels: false, scheduler: false, seed: false });
      try {
        app.tables.create('t', [{ name: 'v', type: 'text' }]);
        app.tables.insert('t', { v: 'x' });
        app.project.setSecret('S', 'value');
      } finally {
        await app.close();
      }
      expect(mode(fresh)).toBe(0o700);
      for (const f of ['jasmine.db', 'tables.db', 'secret.key']) expect(mode(path.join(fresh, f)), f).toBe(0o600);

      const old = path.join(root, 'old');
      const first = await Jasmine.create({ dataDir: old, env: { LLM_PROVIDER: 'mock' }, probeModels: false, scheduler: false, seed: false });
      await first.close();
      for (const f of ['jasmine.db', 'tables.db']) chmodSync(path.join(old, f), 0o644);
      writeFileSync(path.join(old, 'jasmine.db-wal'), '', { mode: 0o644 });
      const second = await Jasmine.create({ dataDir: old, env: { LLM_PROVIDER: 'mock' }, probeModels: false, scheduler: false, seed: false });
      await second.close();
      for (const f of ['jasmine.db', 'tables.db']) expect(mode(path.join(old, f)), f).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('SQLite parameter numbering', () => {
  it('binds explicit ? parameters and templates by number, regardless of order in the text', () => {
    expect(numberSqliteParameters('SELECT __jasmine_param_2__ AS a, ? AS b', 1)).toBe('SELECT ?2 AS a, ?1 AS b');
    expect(numberSqliteParameters("SELECT '?', \"?\", [?], `?`, ? -- ?\n/* ? */, __jasmine_param_3__, ?", 2)).toBe("SELECT '?', \"?\", [?], `?`, ?1 -- ?\n/* ? */, ?3, ?2");
    expect(numberSqliteParameters("SELECT 'it''s', ?7", 0)).toBe("SELECT 'it''s', ?7");
    expect(() => numberSqliteParameters("SELECT 'x __jasmine_param_1__'", 0)).toThrow(/whole bound value/);
    expect(() => numberSqliteParameters('SELECT ?, ?', 1)).toThrow(/Not enough/);
    expect(() => numberSqliteParameters('SELECT __jasmine_param_1__', 1)).toThrow(/marker/);
  });

  it('keeps a template that precedes an explicit parameter in its own slot (Tables node)', async () => {
    const t = await createTestApp();
    try {
      t.app.tables.create('notes', [{ name: 'owner', type: 'text' }, { name: 'body', type: 'text' }]);
      t.app.tables.insert('notes', [{ owner: 'alice', body: 'alice private' }, { owner: 'bob', body: 'bob public' }]);
      const flow = (query: string, params: string) => ({
        nodes: [
          { id: 't', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
          { id: 'x', data: { nodeId: 'tablesNode', values: { action: 'query', query, params } } },
          { id: 'r', type: 'responseNode', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"rows": "{{x.output.rows}}"}' } } },
        ],
        edges: [{ source: 't', target: 'x' }, { source: 'x', target: 'r' }],
      });
      await t.app.deployments.deploy('swap', flow('SELECT {{t.output.q}} AS user_input, ? AS fixed', '["FIXED"]'));
      expect((await t.app.runs.executeWorkflow('swap', { q: 'USER' })).output).toEqual({ rows: [{ user_input: 'USER', fixed: 'FIXED' }] });
      await t.app.deployments.deploy('owner', flow('SELECT body FROM notes WHERE body LIKE {{t.output.q}} AND owner = ?', '["bob"]'));
      expect((await t.app.runs.executeWorkflow('owner', { q: '%' })).output).toEqual({ rows: [{ body: 'bob public' }] });
      await t.app.deployments.deploy('named', flow('SELECT body FROM notes WHERE owner = :owner AND body LIKE {{t.output.q}}', '{"owner":"alice"}'));
      expect((await t.app.runs.executeWorkflow('named', { q: 'alice%' })).output).toEqual({ rows: [{ body: 'alice private' }] });
    } finally {
      await t.close();
    }
  });

  it('still refuses writes through the read-only query', () => {
    const store = new TablesStore(':memory:');
    try {
      expect(() => store.query('DELETE FROM _jasmine_tables')).toThrow(/Only a single SELECT/);
    } finally {
      store.close();
    }
  });
});
