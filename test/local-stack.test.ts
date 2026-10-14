import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { JasmineClient } from '../sdk/jasmine.mjs';
import { createTestApp, withHttp } from './helpers.ts';

const execute = promisify(execFile);

/** Real HTTP protocol fixture, not a real language model. */
async function withLocalModel(run: (base: string, calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      calls.push(req.url!); let text = ''; for await (const chunk of req) text += String(chunk);
      const body = text ? JSON.parse(text) : {};
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'local-chat' }, { id: 'local-embed' }] }));
      else if (req.url === '/v1/embeddings') res.end(JSON.stringify({ model: 'local-embed', data: body.input.map((s: string, index: number) => ({ index, embedding: [/port|8787/i.test(s) ? 1 : 0.1, /workflow/i.test(s) ? 1 : 0.1, 0.2] })), usage: { prompt_tokens: 12 } }));
      else if (req.url === '/v1/chat/completions') {
        const answer = body.messages.some((m: { content: string }) => m.content.includes('8787')) ? 'Jasmine uses port 8787. [1]' : 'Hello from a local HTTP provider.';
        if (body.stream) {
          res.setHeader('content-type', 'text/event-stream');
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`);
        } else res.end(JSON.stringify({ model: 'local-chat', choices: [{ message: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8 } }));
      } else { res.statusCode = 404; res.end('{}'); }
    })().catch(() => { res.statusCode = 500; res.end('{}'); });
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

describe('complete local protocol stack', () => {
  it('connects a local HTTP model, embeds a document, performs RAG, and exposes the run through the SDK', async () => {
    await withLocalModel(async (baseUrl, calls) => {
      const t = await createTestApp();
      try {
        t.app.connections.upsert({ id: 'local-server', name: 'Local fixture', kind: 'openai', baseUrl, chatModel: 'local-chat', embeddingModel: 'local-embed' });
        t.app.connections.setDefaults({ chat: 'local-server', embedding: 'local-server' });
        t.app.vectors.createCollection({ name: 'handbook', embeddingConnection: 'local-server', embeddingModel: 'local-embed' });
        const doc = t.app.knowledge.ingest({ collection: 'handbook', text: 'Jasmine uses port 8787. It runs local workflows.' });
        expect((await t.app.knowledge.wait(doc.id)).status).toBe('ready');
        const template = (await t.app.templates()).find((x) => x.id === 'knowledge-qa')!;
        await t.app.workspace.save('rag', template.name, template.definition); await t.app.deployFlow('rag');
        await withHttp(t.app, async (base) => {
          const client = new JasmineClient({ endpoint: base });
          const run = await client.executeFlow('rag', { question: 'Which port does Jasmine use?' }, { mode: 'async' });
          const complete = await client.wait(run.requestId);
          expect(complete.status).toBe('success'); expect(JSON.stringify(complete.output)).toContain('8787');
          const detail = t.app.runStore.get(run.requestId)!;
          expect(detail.models).toContain('local-server/local-chat'); expect(detail.inputTokens).toBeGreaterThan(0);
        });
        expect(calls).toContain('/v1/embeddings'); expect(calls).toContain('/v1/chat/completions');
      } finally { await t.close(); }
    });
  });

  it('lets the dependency-free Python SDK call the live execution API', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('echo', { nodes: [
        { id: 't', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
        { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: { message: '{{t.output.message}}' } } } },
      ], edges: [{ source: 't', target: 'r' }] });
      await withHttp(t.app, async (base) => {
        const code = "import json,sys; from sdk.jasmine import JasmineClient; c=JasmineClient(sys.argv[1]); r=c.execute_flow('echo', {'message':'python'}, mode='async', idempotency_key='python-once'); s=c.wait(r['requestId']); print(json.dumps({'status':s['status'],'output':s['output'],'trace':len(c.trace(r['requestId'])['trace'])}))";
        const { stdout } = await execute(process.platform === 'win32' ? 'python' : 'python3', ['-c', code, base], { cwd: path.resolve('.'), timeout: 10000 });
        expect(JSON.parse(stdout)).toMatchObject({ status: 'success', output: { message: 'python' } });
        expect(JSON.parse(stdout).trace).toBeGreaterThan(0);
      });
    } finally { await t.close(); }
  });
});
