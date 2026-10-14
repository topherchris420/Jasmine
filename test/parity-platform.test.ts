import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { Jasmine } from '../src/app.ts';
import { editPdf } from '../src/integrations/documents.ts';
import { recognizeDocument } from '../src/integrations/ocr.ts';
import { sendMail } from '../src/integrations/smtp.ts';
import { MockLLMProvider } from '../src/llm/mock.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, fakeFetch, jsonRequest, withHttp } from './helpers.ts';

const flow = (type: string, values: Record<string, unknown>) => ({
  nodes: [
    { id: 't', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
    { id: 'a', data: { nodeId: type, values } },
    { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{{a.output}}' } } },
  ],
  edges: [
    { source: 't', target: 'a' },
    { source: 'a', target: 'r' },
  ],
});
const echo = (type = 'graphqlNode') => ({
  nodes: [
    { id: 't', type: 'triggerNode', data: { nodeId: type, trigger: true, values: {} } },
    { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{{t.output}}' } } },
  ],
  edges: [{ source: 't', target: 'r' }],
});
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

describe('new standalone capability contracts', () => {
  it('implements Gmail mailbox reads and drafts without SMTP fallback', async () => {
    const http = fakeFetch((url, init) => {
      if (url.includes('/threads?')) return json({ threads: [{ id: 'thread' }], nextPageToken: 'next' });
      if (url.endsWith('/drafts')) {
        const b = JSON.parse(String(init.body));
        const raw = Buffer.from(b.message.raw, 'base64url').toString();
        expect(raw).toContain('To: test@example.invalid');
        expect(raw).toContain('Content-Transfer-Encoding: base64');
        return json({ id: 'draft' });
      }
      return json({ labels: [{ id: 'INBOX' }] });
    });
    const t = await createTestApp({ fetch: http });
    try {
      t.app.credentials.upsert({ integration: 'gmail', name: 'mail', data: { accessToken: 'mail-token' } });
      await t.app.deployments.deploy(
        'g',
        flow('gmailNode', { action: 'listThreads', list_threads_query: 'is:unread' }),
      );
      expect((await t.app.runs.executeWorkflow('g', {})).output).toMatchObject({ threads: [{ id: 'thread' }] });
      await t.app.deployments.deploy(
        'g',
        flow('gmailNode', {
          action: 'createDraft',
          recipient_email: 'test@example.invalid',
          subject: 'Test',
          body: 'Hello',
        }),
      );
      expect((await t.app.runs.executeWorkflow('g', {})).output).toEqual({ id: 'draft' });
      await t.app.deployments.deploy('g', flow('gmailNode', { action: 'typo' }));
      expect((await t.app.runs.executeWorkflow('g', {})).error?.code).toBe('BAD_PAYLOAD');
      expect(http.calls).toHaveLength(2);
    } finally {
      await t.close();
    }
  });
  it('reads Webflow CMS with encoded identifiers and pagination', async () => {
    const http = fakeFetch((url, init) => {
      expect(url).toContain('/collections/a%2Fb/items');
      expect(url).toContain('offset=100');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer cms-token');
      return json({ items: [{ id: 'one' }] });
    });
    const t = await createTestApp({ fetch: http });
    try {
      t.app.credentials.upsert({ integration: 'webflow', name: 'cms', data: { token: 'cms-token' } });
      await t.app.deployments.deploy(
        'w',
        flow('webflowNode', { action: 'listItems', collectionId: 'a/b', offset: 100 }),
      );
      expect((await t.app.runs.executeWorkflow('w', {})).output).toEqual({ items: [{ id: 'one' }] });
    } finally {
      await t.close();
    }
  });
  it('exposes flow tools over MCP and enforces key scopes', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('echo', echo());
      const admin = t.app.apiKeys.create('admin', 'admin').token,
        execute = t.app.apiKeys.create('execute', 'execute').token;
      await withHttp(t.app, async (base) => {
        const req = jsonRequest(base, { authorization: `Bearer ${execute}` });
        const msg = (method: string, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
        const tools = (await req('/mcp', 'POST', msg('tools/list'))).data.result.tools;
        expect(tools.some((x: { name: string }) => x.name === 'flow_echo')).toBe(true);
        expect(tools.some((x: { name: string }) => x.name === 'flows_delete')).toBe(false);
        const result = await req(
          '/mcp',
          'POST',
          msg('tools/call', { name: 'flow_echo', arguments: { message: 'MCP' } }),
        );
        expect(JSON.parse(result.data.result.content[0].text).output).toEqual({ message: 'MCP' });
        expect(
          (await req('/mcp', 'POST', msg('tools/call', { name: 'flows_delete', arguments: { id: 'echo' } }))).status,
        ).toBe(403);
        expect(
          (
            await jsonRequest(base, { authorization: `Bearer ${admin}` })('/mcp', 'POST', msg('tools/list'))
          ).data.result.tools.some((x: { name: string }) => x.name === 'flows_save'),
        ).toBe(true);
      });
    } finally {
      await t.close();
    }
  });
  it('stores feedback through GraphQL and reports it without dropping unrated comments', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('e', echo());
      const run = await t.app.runs.executeWorkflow('e', {});
      await withHttp(t.app, async (base) => {
        const req = jsonRequest(base);
        const feedback = await req('/graphql', 'POST', {
          query: 'mutation($id:String!){submitFeedback(requestId:$id,rating:5,comment:"Useful"){success data}}',
          variables: { id: run.requestId },
        });
        expect(feedback.data.data.submitFeedback.success).toBe(true);
        expect((await req('/api/feedback', 'POST', { requestId: run.requestId, comment: 'No rating' })).status).toBe(
          200,
        );
        expect((await req('/api/feedback', 'POST', { requestId: run.requestId })).status).toBe(400);
        expect((await req('/api/reports')).data.feedback).toMatchObject({ count: 2, rated: 1, avgRating: 5 });
      });
    } finally {
      await t.close();
    }
  });
  it('caches safe flows, bypasses on request, and invalidates when project context changes', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('e', echo());
      t.app.cache.configure('e', { enabled: true, ttlSeconds: 60 });
      const a = await t.app.runs.executeWorkflow('e', { value: 1 });
      const b = await t.app.runs.executeWorkflow('e', { value: 1 });
      expect(b.cached).toBe(true);
      expect(b.requestId).toBe(a.requestId);
      const c = await t.app.runs.executeWorkflow('e', { value: 1 }, { bypassCache: true });
      expect(c.requestId).not.toBe(a.requestId);
      t.app.project.setEnv({ MODE: 'changed' });
      expect((await t.app.runs.executeWorkflow('e', { value: 1 })).cached).not.toBe(true);
      await t.app.deployments.deploy('e', flow('gmailNode', { action: 'GMAIL_SEND_EMAIL' }));
      expect(t.app.cache.key(t.app.deployments.getActive('e')!.plan, {})).toBeUndefined();
    } finally {
      await t.close();
    }
  });
  it('keeps durable idempotency and exact execution results across restart', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'jasmine-durable-key-'));
    const config = { dataDir, env: { LLM_PROVIDER: 'mock' }, probeModels: false, scheduler: false, seed: false };
    let app = await Jasmine.create(config);
    try {
      await app.deployments.deploy('e', echo());
      const input = { message: 'x'.repeat(10000), secret: 'unclipped-execution-data' };
      const run = await app.runs.executeWorkflow('e', input, { idempotencyKey: 'stable' });
      await app.close();
      app = await Jasmine.create(config);
      const same = await app.runs.executeWorkflow('e', input, { idempotencyKey: 'stable' });
      expect(same.requestId).toBe(run.requestId);
      expect(same.output).toEqual(input);
      expect(JSON.stringify(app.db.all('SELECT * FROM execution_state'))).not.toContain(input.secret);
      await expect(app.runs.executeWorkflow('e', { other: true }, { idempotencyKey: 'stable' })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  it('validates assistant proposals before applying and rejects stale revisions', async () => {
    const valid = echo();
    const model = new MockLLMProvider({
      respond: () => JSON.stringify({ explanation: 'Use an API trigger.', definition: valid }),
    });
    const t = await createTestApp({ llm: model });
    try {
      await t.app.workspace.save('e', 'Echo', valid);
      const proposal = await t.app.assistant.ask({ flowId: 'e', message: 'Improve this', propose: true });
      expect(proposal.validation?.ok).toBe(true);
      await t.app.assistant.apply('e', { definition: valid, expectedRevision: 1 });
      await expect(t.app.assistant.apply('e', { definition: valid, expectedRevision: 1 })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      const bad = flow('imaginaryNode', {});
      await expect(t.app.assistant.apply('e', { definition: bad, expectedRevision: 2 })).rejects.toMatchObject({
        code: 'COMPILE',
      });
    } finally {
      await t.close();
    }
  });
  it('receives a real local SMTP message with a stable recipient and executes the mail flow', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('mail', echo('mailhookNode'));
      const address = t.app.mailhook.addresses()[0]!.address;
      expect(t.app.mailhook.addresses()[0]!.address).toBe(address);
      const port = await t.app.mailhook.start(0);
      await sendMail(
        { host: '127.0.0.1', port, secure: false, from: 'sender@example.invalid' },
        { to: [address], subject: 'SMTP integration', body: 'Inbound email works.' },
        AbortSignal.timeout(10000),
      );
      const runs = t.app.runStore.list({ flowId: 'mail' }).runs;
      expect(runs).toHaveLength(1);
      const result = await t.app.runs.wait(runs[0]!.id);
      expect(result.output).toMatchObject({ subject: 'SMTP integration', text: 'Inbound email works.' });
    } finally {
      await t.close();
    }
  });
});

describe('local document intelligence', () => {
  it('edits every PDF operation group and preserves bookmarks and metadata', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    doc.addPage();
    const bytes = await doc.save();
    const cases = [
      { type: 'pages', operation: 'extract', pages: '1,3', count: 2 },
      { type: 'pages', operation: 'delete', pages: '2', count: 2 },
      { type: 'pages', operation: 'reorder', pageOrder: '3,1,1', count: 3 },
      { type: 'pages', operation: 'insertBlank', position: 1, count: 2, want: 5 },
      { type: 'pages', operation: 'insertDocument', position: 1, sourcePages: '2', count: 4 },
      { type: 'merge', count: 6 },
    ];
    for (const v of cases) {
      const result = await editPdf([bytes, bytes], v);
      expect(result.pageCounts?.[0]).toBe(v.want ?? v.count);
    }
    for (const operation of ['everyPage', 'everyN', 'atPages']) {
      const result = await editPdf([bytes], { type: 'split', operation, pagesPerFile: 2, pages: '2' });
      expect(result.bytes?.length).toBe(operation === 'everyPage' ? 3 : 2);
    }
    const bookmarked = await editPdf([bytes], {
      type: 'bookmarks',
      operation: 'set',
      bookmarks: [{ title: 'First', page: 1, children: [{ title: 'Second', page: 2 }] }],
    });
    expect((await editPdf([bookmarked.bytes![0]!], { type: 'bookmarks', operation: 'list' })).bookmarks).toMatchObject([
      { title: 'First', page: 1, children: [{ title: 'Second', page: 2 }] },
    ]);
    const stamped = await editPdf([bytes], { type: 'metadata', operation: 'set', title: 'Jasmine' });
    expect((await editPdf([stamped.bytes![0]!], { type: 'metadata', operation: 'get' })).metadata).toMatchObject({
      title: 'Jasmine',
    });
    await expect(editPdf([bytes], { type: 'pages', operation: 'extract', pages: '99' })).rejects.toMatchObject({
      code: 'BAD_PAYLOAD',
    });
  });
  it('recognizes text without network access using bundled OCR data', async () => {
    const canvas = createCanvas(800, 160),
      ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 800, 160);
    ctx.fillStyle = 'black';
    ctx.font = '52px sans-serif';
    ctx.fillText('JASMINE 8787', 30, 95);
    const pages = await recognizeDocument(canvas.toBuffer('image/png'), AbortSignal.timeout(25000));
    expect(pages[0]!.text).toContain('8787');
    expect(pages[0]!.confidence).toBeGreaterThan(0);
    expect(pages[0]!.tsv).toContain('8787');
  }, 30000);
  it('exports an encrypted full backup and restores data, tables and credentials into a new workspace', async () => {
    const t = await createTestApp();
    try {
      await t.app.workspace.save('e', 'Echo', echo());
      t.app.project.setSecret('VALUE', 'sensitive-backup-value');
      t.app.tables.create('items', [{ name: 'name', type: 'text' }]);
      t.app.tables.insert('items', { name: 'Kept' });
      const backup = await t.app.backups.export('a-test-passphrase-123');
      expect(JSON.stringify(backup)).not.toContain('sensitive-backup-value');
      const restored = await t.app.backups.restore(backup, 'a-test-passphrase-123');
      const app = await Jasmine.create({
        dataDir: restored.dataDir,
        probeModels: false,
        scheduler: false,
        seed: false,
      });
      try {
        expect(app.project.secrets()['VALUE']).toBe('sensitive-backup-value');
        expect(app.workspace.get('e')?.name).toBe('Echo');
        expect(app.tables.select('items')).toMatchObject({ rows: [{ name: 'Kept' }] });
      } finally {
        await app.close();
      }
      await expect(t.app.backups.restore(backup, 'wrong-password')).rejects.toMatchObject({ code: 'BAD_PAYLOAD' });
    } finally {
      await t.close();
    }
  });
});
