import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { Jasmine } from '../src/app.ts';
import { editPdf } from '../src/integrations/documents.ts';
import { recognizeDocument } from '../src/integrations/ocr.ts';
import { ipFilter } from '../src/api/server.ts';
import { createTestApp, fakeFetch, jsonRequest, withHttp } from './helpers.ts';

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
const echo = (type = 'graphqlNode', values = {}) => ({
  nodes: [
    { id: 't', data: { nodeId: type, trigger: true, values } },
    { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{{t.output}}' } } },
  ],
  edges: [{ source: 't', target: 'r' }],
});

describe('connected and durable contracts', () => {
  it('upgrades a version-two workspace without losing prior credentials and drafts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jasmine-upgrade-'));
    const config = {dataDir: dir, env: {LLM_PROVIDER: 'mock'}, scheduler: false, probeModels: false, seed: false};
    let app = await Jasmine.create(config);
    try {
      app.project.setSecret('KEPT', 'existing-secret');
      await app.workspace.save('kept', 'Existing flow', echo());
      for (const table of ['execution_keys','execution_state','response_cache','run_feedback','oauth_states']) app.db.sqlite.exec(`DROP TABLE ${table}`);
      app.db.run('DELETE FROM schema_migrations WHERE version>=3');
      await app.close(); app = await Jasmine.create(config);
      expect(app.project.secrets()['KEPT']).toBe('existing-secret');
      expect(app.workspace.get('kept')?.name).toBe('Existing flow');
      // Migrations 3 (durable execution) and 4 (per-collection keyword indexes) both re-apply.
      expect(app.db.get<{version:number}>('SELECT MAX(version) AS version FROM schema_migrations')?.version).toBe(4);
      expect(app.db.all('SELECT * FROM oauth_states')).toEqual([]);
    } finally { await app.close(); await rm(dir,{recursive:true,force:true}); }
  });

  it('enforces configured IP subnets using the actual socket address', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async base => { expect((await fetch(base+'/api/status')).status).toBe(200); }, {ipAllowlist:['127.0.0.0/8']});
      // Outside the list, a loopback client may only read the health check; a spoofed X-Forwarded-For changes nothing.
      await withHttp(t.app, async base => {
        expect((await fetch(base+'/api/status',{headers:{'x-forwarded-for':'192.168.1.1'}})).status).toBe(200);
        expect((await fetch(base+'/api/flows',{headers:{'x-forwarded-for':'10.0.0.1'}})).status).toBe(403);
      }, {ipAllowlist:['10.0.0.0/8']});
      // The server's matcher sees only the socket address: other clients outside the list are refused.
      const allowed = ipFilter(['10.0.0.0/8']);
      expect([allowed('10.0.0.1'), allowed('::ffff:10.0.0.1'), allowed('192.168.1.1'), allowed('::ffff:192.168.1.1')]).toEqual([true, true, false, false]);
    } finally { await t.close(); }
  });
  it('uses PKCE, encrypts OAuth state and tokens, and consumes the callback once', async () => {
    let authorization: URL;
    const http = fakeFetch((url, init) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const form = new URLSearchParams(String(init.body));
      expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
        authorization.searchParams.get('code_challenge'),
      );
      expect(form.get('client_secret')).toBe('fixture-client-secret');
      return json({ access_token: 'private-access-token', refresh_token: 'private-refresh-token' });
    });
    const t = await createTestApp({ fetch: http });
    try {
      t.app.oauth.configure('google', {
        clientId: 'fixture-client',
        clientSecret: 'fixture-client-secret',
        redirectUri: 'http://127.0.0.1:8787/oauth/callback/google',
      });
      authorization = new URL(t.app.oauth.begin('gmail', 'Inbox').authorizationUrl);
      expect(authorization.searchParams.get('scope')).toContain('gmail.readonly');
      const state = authorization.searchParams.get('state')!;
      expect(JSON.stringify(t.app.db.all('SELECT * FROM oauth_states'))).not.toContain(state);
      await expect(t.app.oauth.finish('microsoft', state, 'code')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const credential = await t.app.oauth.finish('google', state, 'code');
      expect(credential.integration).toBe('gmail');
      expect(t.app.credentials.resolve('Inbox', 'gmail')).toMatchObject({
        accessToken: 'private-access-token',
        refreshToken: 'private-refresh-token',
      });
      expect(JSON.stringify(t.app.db.all('SELECT * FROM credentials'))).not.toContain('private-access-token');
      await expect(t.app.oauth.finish('google', state, 'code')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(http.calls).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it('schedules source reads and blocks writes before making a request', async () => {
    const http = fakeFetch(() => json({ files: [{ id: 'document' }] }));
    const t = await createTestApp({ fetch: http });
    try {
      t.app.credentials.upsert({ integration: 'google-drive', name: 'drive', data: { accessToken: 'token' } });
      const values = {
        sourceNodeType: 'googleDriveNode',
        sourceConfig: { action: 'list' },
        recordsField: 'files',
        cronExpression: '* * * * *',
      };
      await t.app.deployments.deploy('source', echo('sourceTriggerNode', values));
      expect(t.app.scheduler.list()[0]?.trigger).toBe('sourceTriggerNode');
      const id = await t.app.scheduler.runNow('source');
      expect((await t.app.runs.wait(id!)).output).toMatchObject({ records: [{ id: 'document' }] });
      await t.app.deployments.deploy(
        'source',
        echo('sourceTriggerNode', { ...values, sourceConfig: { action: 'delete', fileId: 'document' } }),
      );
      expect((await t.app.runs.executeWorkflow('source', {})).error?.code).toBe('BAD_PAYLOAD');
      expect(http.calls).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it('retries a failed run after restart without repeating the successful HTTP action', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jasmine-retry-'));
    let healthy = false;
    const counts = { first: 0, second: 0 };
    const http = fakeFetch((url) => {
      if (url.endsWith('/first')) {
        counts.first++;
        return json({ retained: 'yes' });
      }
      counts.second++;
      return healthy ? json({ recovered: true }) : new Response('Temporary failure', { status: 503 });
    });
    const config = {
      dataDir: dir,
      fetch: http,
      env: { LLM_PROVIDER: 'mock' },
      scheduler: false,
      probeModels: false,
      seed: false,
    };
    let app = await Jasmine.create(config);
    try {
      await app.deployments.deploy('retry', {
        nodes: [
          { id: 't', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
          { id: 'first', data: { nodeId: 'apiNode', values: { url: 'https://fixture.invalid/first', method: 'GET' } } },
          {
            id: 'second',
            data: { nodeId: 'apiNode', values: { url: 'https://fixture.invalid/second', method: 'GET' } },
          },
          {
            id: 'r',
            data: {
              nodeId: 'graphqlResponseNode',
              values: { outputMapping: { first: '{{first.output}}', second: '{{second.output}}' } },
            },
          },
        ],
        edges: [
          { source: 't', target: 'first' },
          { source: 'first', target: 'second' },
          { source: 'second', target: 'r' },
        ],
      });
      const failed = await app.runs.executeWorkflow('retry', {});
      expect(failed.status).toBe('failed');
      await app.close();
      healthy = true;
      app = await Jasmine.create(config);
      const recovered = await app.runs.retryWorkflow(failed.requestId);
      expect(recovered.status).toBe('success');
      expect(recovered.output).toEqual({ first: { retained: 'yes' }, second: { recovered: true } });
      expect(counts).toEqual({ first: 1, second: 2 });
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs CLI commands against an actual local server', async () => {
    const t = await createTestApp();
    try {
      await t.app.workspace.save('echo', 'CLI Echo', echo());
      await t.app.deployments.deploy('echo', echo());
      await withHttp(t.app, async (base) => {
        const command = async (...args: string[]) =>
          JSON.parse(
            (
              await promisify(execFile)(process.execPath, ['sdk/cli.mjs', ...args], {
                env: { ...process.env, JASMINE_ENDPOINT: base, JASMINE_CLI_CONFIG: path.join(t.dataDir, 'cli.json') },
              })
            ).stdout,
          );
        expect((await command('flows', 'list')).some((f: { id: string }) => f.id === 'echo')).toBe(true);
        expect((await command('flows', 'run', 'echo', '--json', '{"value":42}')).output).toEqual({ value: 42 });
        expect((await command('flows', 'get', 'echo')).name).toBe('CLI Echo');
      });
    } finally {
      await t.close();
    }
  });

  it('restores a backup larger than the ordinary JSON request limit', async () => {
    const t = await createTestApp();
    try {
      t.app.files.save(Buffer.alloc(2_100_000, 42), 'large.bin', 'application/octet-stream');
      const passphrase = 'fixture-backup-passphrase';
      const backup = await t.app.backups.export(passphrase);
      expect(JSON.stringify(backup).length).toBeGreaterThan(2_000_000);
      await withHttp(t.app, async (base) => {
        const result = await jsonRequest(base)('/api/backups/restore', 'POST', { backup, passphrase });
        expect(result.status).toBe(200);
        expect(result.data.restartRequired).toBe(true);
      });
    } finally {
      await t.close();
    }
  });
});

describe('PDF image and file contracts', () => {
  it('renders and recognizes a PDF locally and extracts its embedded figure', async () => {
    const canvas = createCanvas(600, 120),
      ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 600, 120);
    ctx.fillStyle = 'black';
    ctx.font = '44px sans-serif';
    ctx.fillText('JASMINE 8787', 15, 80);
    const doc = await PDFDocument.create(),
      page = doc.addPage([600, 200]);
    page.drawImage(await doc.embedPng(canvas.toBuffer('image/png')), { x: 0, y: 40, width: 600, height: 120 });
    const pages = await recognizeDocument(await doc.save(), AbortSignal.timeout(25000));
    expect(pages[0]?.text).toContain('8787');
    expect(pages[0]?.figures?.length).toBe(1);
    expect(pages[0]?.figures?.[0]?.width).toBeGreaterThan(0);
  }, 30000);

  it('preserves nested bookmarks while merging selected page ranges', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    const marked = await editPdf([await doc.save()], {
      type: 'bookmarks',
      operation: 'set',
      bookmarks: [{ title: 'Parent', page: 1, children: [{ title: 'Child', page: 2 }] }],
    });
    const merged = await editPdf([marked.bytes![0]!, marked.bytes![0]!], { type: 'merge', pageRanges: ['1-2', '2'] });
    expect((await editPdf([merged.bytes![0]!], { type: 'bookmarks', operation: 'list' })).bookmarks).toEqual([
      { title: 'Parent', page: 1, children: [{ title: 'Child', page: 2 }] },
      { title: 'Child', page: 3 },
    ]);
  });

  it('serves generated files only with a valid unexpired token', async () => {
    const t = await createTestApp();
    try {
      const file = t.app.files.save(Buffer.from('generated document'), 'result.txt', 'text/plain');
      const signed = new URL(t.app.fileUrl(file.id));
      await withHttp(t.app, async (base) => {
        expect(await (await fetch(base + signed.pathname + signed.search)).text()).toBe('generated document');
        expect((await fetch(base + signed.pathname)).status).toBe(403);
        expect((await fetch(base + signed.pathname + '?token=invalid')).status).toBe(403);
      });
      const expired = Buffer.from(t.app.box.sealJson({ id: file.id, expiresAt: Date.now() - 1 })).toString('base64url');
      expect(t.app.verifyFileToken(file.id, expired)).toBe(false);
    } finally {
      await t.close();
    }
  });
});
