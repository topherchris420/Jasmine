import { createHmac } from 'node:crypto';
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api/graphql.ts';
import { MockLLMProvider } from '../src/llm/providers.ts';
import { defaultRegistry } from '../src/nodes/builtin.ts';
import { DeploymentRegistry } from '../src/service/deployments.ts';
import { RunService } from '../src/service/runs.ts';
import { createTestApp, fakeFetch, jsonRequest, makeServices, readEvents, studioArticleSummariser, withHttp } from './helpers.ts';

function setup() {
  const http = fakeFetch(() => new Response('Long article text…', { headers: { 'content-type': 'text/plain' } }));
  const llm = new MockLLMProvider({ respond: () => 'He said "fine".\nShort summary.' });
  const deployments = new DeploymentRegistry(defaultRegistry());
  const runs = new RunService(deployments, { services: makeServices(llm, http) });
  return { api: createApi(deployments, runs), http };
}

const DEPLOY = `mutation Deploy($def: JSON!) { deployFlow(workflowId: "article", definition: $def) { version changed diagnostics { code } } }`;
const EXECUTE = `query Run($wf: String!, $p: JSON) { executeWorkflow(workflowId: $wf, payload: $p) { status requestId result output nodes statusCode error { code message nodeId } } }`;

describe('GraphQL API', () => {
  it('deploys a Studio export and executes it with executeWorkflow (result is the flow output)', async () => {
    const { api, http } = setup();
    const deployed = await api.execute(DEPLOY, { def: studioArticleSummariser() });
    expect(deployed.errors).toBeUndefined();
    const res = await api.execute(EXECUTE, { wf: 'article', p: { url: 'https://news.example/a' } });
    const data = res.data!['executeWorkflow'] as { status: string; requestId: string; result: unknown; output: unknown; nodes: unknown[]; statusCode: number };
    expect(data.status).toBe('success');
    expect(data.result).toEqual({ summary: 'He said "fine".\nShort summary.' });
    expect(data.output).toEqual(data.result);
    expect(data.statusCode).toBe(200);
    expect(data.nodes).toHaveLength(4);
    expect(http.calls[0]?.url).toBe('https://news.example/a');

    const status = await api.execute(`query { checkStatus(requestId: "${data.requestId}") { status result } }`);
    expect(status.data).toEqual({ checkStatus: { status: 'success', result: { summary: 'He said "fine".\nShort summary.' } } });
  });

  it('returns machine-readable error codes instead of message strings', async () => {
    const { api } = setup();
    const missing = await api.execute(EXECUTE, { wf: 'nope', p: {} });
    expect(missing.errors?.[0]?.extensions).toMatchObject({ code: 'NOT_FOUND', retryable: false });

    const broken = studioArticleSummariser();
    broken.edges.push({ id: 'loop', source: 'LLMNode_160', target: 'apiNode_252', sourceHandle: 'bottom', targetHandle: 'top', type: 'defaultEdge' });
    const res = await api.execute(DEPLOY, { def: broken });
    expect(res.errors?.[0]?.extensions?.['code']).toBe('COMPILE');
    expect((res.errors?.[0]?.extensions?.['diagnostics'] as { code: string }[]).map((d) => d.code)).toContain('CYCLE');
  });

  it('exposes execution as a mutation too, since it has side effects', async () => {
    const { api } = setup();
    await api.execute(DEPLOY, { def: studioArticleSummariser() });
    const res = await api.execute(`mutation($p: JSON) { executeWorkflow(workflowId: "article", payload: $p) { status } }`, { p: { url: 'https://x.example' } });
    expect(res.data).toEqual({ executeWorkflow: { status: 'success' } });
  });

  it('refuses deploys from execute-scoped keys', async () => {
    const { api } = setup();
    const res = await api.execute(DEPLOY, { def: studioArticleSummariser() }, undefined, { scope: 'execute' });
    expect(res.errors?.[0]?.extensions?.['code']).toBe('FORBIDDEN');
  });
});

const HEALTH_QUERY = '{ flowVersions(workflowId: "x") { version } }';
const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

async function expectHealthy(base: string) {
  const response = await postJson(`${base}/graphql`, { query: HEALTH_QUERY });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { flowVersions: [] } });
}

describe('HTTP authentication', () => {
  it('is open locally until keys exist, then enforces admin and execute scopes and x-project-id', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        const anon = jsonRequest(base);
        expect((await anon('/api/flows')).status).toBe(200);
        expect((await anon('/api/status')).data).toMatchObject({ authRequired: false });

        const { token: admin } = t.app.apiKeys.create('studio', 'admin');
        const { token: exec } = t.app.apiKeys.create('app', 'execute');
        expect((await anon('/api/flows')).status).toBe(403);
        expect((await anon('/api/flows')).data).toEqual({ errors: [{ message: 'Access Denied', extensions: { code: 'FORBIDDEN', retryable: false } }] });
        expect((await jsonRequest(base, { authorization: `Bearer ${exec}` })('/api/flows')).status).toBe(403);
        expect((await jsonRequest(base, { authorization: `Bearer ${admin}` })('/api/flows')).status).toBe(200);
        expect((await jsonRequest(base, { authorization: 'Bearer jsm_x_wrong' })('/api/status')).status).toBe(200);

        expect((await postJson(`${base}/graphql`, { query: HEALTH_QUERY })).status).toBe(403);
        expect((await postJson(`${base}/graphql`, { query: HEALTH_QUERY }, { authorization: `Bearer ${exec}` })).status).toBe(200);
        const deploy = await postJson(`${base}/graphql`, { query: DEPLOY, variables: { def: studioArticleSummariser() } }, { authorization: `Bearer ${exec}` });
        expect(((await deploy.json()) as { errors: { extensions: { code: string } }[] }).errors[0]!.extensions.code).toBe('FORBIDDEN');

        const [key] = t.app.apiKeys.list().filter((k) => k.scope === 'execute');
        t.app.apiKeys.revoke(key!.id);
        expect((await postJson(`${base}/graphql`, { query: HEALTH_QUERY }, { authorization: `Bearer ${exec}` })).status).toBe(403);
      });

    } finally {
      await t.close();
    }
  });
});

describe('HTTP authentication with an environment key', () => {
  it('accepts JASMINE_API_KEY as an admin key and enforces x-project-id when configured', async () => {
    const t = await createTestApp({ env: { LLM_PROVIDER: 'mock', JASMINE_API_KEY: 'test-key' } });
    try {
      await withHttp(t.app, async (base) => {
        expect((await postJson(`${base}/graphql`, { query: HEALTH_QUERY })).status).toBe(403);
        expect((await postJson(`${base}/graphql`, { query: HEALTH_QUERY }, { authorization: 'Bearer test-key' })).status).toBe(403);
        expect((await postJson(`${base}/graphql`, { query: HEALTH_QUERY }, { authorization: 'Bearer test-key', 'x-project-id': 'proj-1' })).status).toBe(200);
        expect((await jsonRequest(base, { authorization: 'Bearer test-key', 'x-project-id': 'proj-1' })('/api/flows')).status).toBe(200);
      }, { projectId: 'proj-1' });
    } finally {
      await t.close();
    }
  });
});

describe('HTTP request resilience', () => {
  it('rejects invalid envelopes and fields, then accepts valid requests', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        for (const body of [null, [], 'text', 42, true, {}, { query: 3 },
          ...[[], 'bad', 1, false].map((variables) => ({ query: HEALTH_QUERY, variables })),
          ...[{}, [], 1, false].map((operationName) => ({ query: HEALTH_QUERY, operationName }))]) {
          const response = await postJson(`${base}/graphql`, body);
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({ errors: [{ extensions: { code: 'BAD_PAYLOAD' } }] });
        }
        expect((await fetch(`${base}/graphql`, { method: 'POST', body: '{bad json' })).status).toBe(400);
        const nullable = await postJson(`${base}/graphql`, { query: HEALTH_QUERY, variables: null, operationName: null });
        expect(await nullable.json()).toEqual({ data: { flowVersions: [] } });
        expect((await fetch(`${base}/graphql`)).status).toBe(405);
        await expectHealthy(base);
      });
    } finally {
      await t.close();
    }
  });

  it('returns 413 for an oversized body without losing the response or server', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        const response = await postJson(`${base}/graphql`, { query: HEALTH_QUERY, padding: 'x'.repeat(2048) });
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({ errors: [{ extensions: { code: 'PAYLOAD_TOO_LARGE' } }] });
        await expectHealthy(base);
      }, { maxBodyBytes: 1024 });
    } finally {
      await t.close();
    }
  });

  it('contains unexpected rejections without exposing their details', async () => {
    const t = await createTestApp();
    const original = t.app.runs.executeWorkflow.bind(t.app.runs);
    let rejectNext = true;
    t.app.runs.executeWorkflow = (...args) => {
      if (rejectNext) {
        rejectNext = false;
        return Promise.reject(new Error('secret internal backend detail'));
      }
      return original(...args);
    };
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (e: unknown) => errors.push(e);
    try {
      await withHttp(t.app, async (base) => {
        const response = await postJson(`${base}/api/v1/flows/x/execute`, { payload: {} });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ errors: [{ message: 'Internal server error', extensions: { code: 'INTERNAL', retryable: false } }] });
        await expectHealthy(base);
      });
    } finally {
      console.error = log;
      await t.close();
    }
    expect(errors).toHaveLength(1);
  });

  it('survives a client disconnect in the middle of its request body', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        await new Promise<void>((resolve, reject) => {
          const request = http.request(`${base}/graphql`, { method: 'POST', headers: { 'content-length': 100 } });
          request.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ECONNRESET') reject(error);
          });
          request.write('{', () => setTimeout(() => {
            request.destroy();
            resolve();
          }, 50));
        });
        await expectHealthy(base);
      });
    } finally {
      await t.close();
    }
  });
});

const chatFlow = (domains: string[] = ['*']) => ({
  nodes: [
    { id: 'triggerNode_1', type: 'triggerNode', data: { nodeId: 'chatTriggerNode', trigger: true, values: { domains, chatConfig: { botName: 'Ada', greetingMessage: 'Hello' } } } },
    { id: 'LLMNode_1', data: { nodeId: 'LLMNode', values: { prompts: [{ role: 'user', content: '{{triggerNode_1.output.chatMessage}}' }], messages: '{{triggerNode_1.output.chatHistory}}' } } },
    { id: 'responseNode_1', type: 'responseNode', data: { nodeId: 'chatResponseNode', values: { content: '{{LLMNode_1.output.generatedResponse}}' } } },
  ],
  edges: [{ source: 'triggerNode_1', target: 'LLMNode_1' }, { source: 'LLMNode_1', target: 'responseNode_1' }],
});

describe('public execution endpoints', () => {
  it('executes through the REST API with idempotency and async status polling', async () => {
    const t = await createTestApp({ fetch: fakeFetch(() => new Response('text')) });
    try {
      await t.app.deployments.deploy('article', studioArticleSummariser());
      await withHttp(t.app, async (base) => {
        const req = jsonRequest(base);
        const first = await req('/api/v1/flows/article/execute', 'POST', { payload: { url: 'https://a.example' }, idempotencyKey: 'k1' });
        expect(first.data).toMatchObject({ status: 'success', result: { summary: expect.stringContaining('echo:') } });
        const again = await req('/api/v1/flows/article/execute', 'POST', { payload: { url: 'https://a.example' }, idempotencyKey: 'k1' });
        expect(again.data.requestId).toBe(first.data.requestId);
        const queued = await req('/api/v1/flows/article/execute', 'POST', { payload: { url: 'https://b.example' }, mode: 'async' });
        expect(queued.data).toMatchObject({ status: 'in-progress', result: { requestId: queued.data.requestId } });
        await t.app.runs.wait(queued.data.requestId);
        expect((await req(`/api/v1/runs/${queued.data.requestId}`)).data.status).toBe('success');
        expect((await req('/api/v1/flows/missing/execute', 'POST', { payload: {} })).status).toBe(404);
      });
    } finally {
      await t.close();
    }
  });

  it('runs webhook flows, checking shared secrets and HMAC signatures', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('hook', {
        nodes: [
          { id: 't', type: 'triggerNode', data: { nodeId: 'webhookTriggerNode', trigger: true, values: { webhookSecret: 's3cret' } } },
          { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"got": "{{t.output.event}}"}' } } },
        ],
        edges: [{ source: 't', target: 'r' }],
      });
      await withHttp(t.app, async (base) => {
        const body = JSON.stringify({ event: 'push' });
        expect((await fetch(`${base}/webhooks/hook`, { method: 'POST', body })).status).toBe(403);
        const shared = await fetch(`${base}/webhooks/hook`, { method: 'POST', body, headers: { 'x-webhook-secret': 's3cret', 'content-type': 'application/json' } });
        expect(await shared.json()).toMatchObject({ status: 'success', result: { got: 'push' } });
        const signature = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
        const signed = await fetch(`${base}/webhooks/hook`, { method: 'POST', body, headers: { 'x-jasmine-signature': signature } });
        expect(signed.status).toBe(200);
        expect((await fetch(`${base}/webhooks/hook?mode=async&secret=s3cret`, { method: 'POST', body })).status).toBe(202);
        expect((await fetch(`${base}/webhooks/nope`, { method: 'POST', body })).status).toBe(404);
      });
    } finally {
      await t.close();
    }
  });

  it('serves the chat widget API with session history, domain checks and token streaming', async () => {
    const t = await createTestApp({ llm: new MockLLMProvider({ respond: (req) => `You said: ${req.messages.at(-1)!.content} (history ${req.messages.length - 1})` }) });
    try {
      await t.app.deployments.deploy('chat', chatFlow(['example.com']));
      await withHttp(t.app, async (base) => {
        const req = jsonRequest(base);
        expect((await req('/api/chat/chat/config')).data).toMatchObject({ botName: 'Ada', mode: 'chat' });
        const first = await req('/api/chat/chat', 'POST', { chatMessage: 'hi' });
        expect(first.data).toMatchObject({ status: 'success', output: { content: 'You said: hi (history 0)', type: 'text' } });
        const second = await req('/api/chat/chat', 'POST', { chatMessage: 'again', sessionId: first.data.sessionId });
        expect(second.data.output.content).toBe('You said: again (history 2)');
        expect((await req(`/api/chat/chat/history?sessionId=${first.data.sessionId}`)).data.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect((await jsonRequest(base, { origin: 'https://evil.example' })('/api/chat/chat', 'POST', { chatMessage: 'x' })).status).toBe(403);
        const allowed = await jsonRequest(base, { origin: 'https://example.com' })('/api/chat/chat', 'POST', { chatMessage: 'x' });
        expect(allowed.headers.get('access-control-allow-origin')).toBe('https://example.com');
        // The hosted widget page calls from Jasmine's own origin, which the domain list never blocks.
        expect((await jsonRequest(base, { origin: base })('/api/chat/chat', 'POST', { chatMessage: 'x' })).status).toBe(200);

        const stream = await fetch(`${base}/api/chat/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatMessage: 'stream me', stream: true }) });
        const events = await readEvents(stream);
        expect(events[0]![0]).toBe('session');
        expect(events.filter(([e]) => e === 'token').map(([, d]) => d.text).join('')).toBe('You said: stream me (history 0)');
        expect(events.at(-1)).toEqual(['message', expect.objectContaining({ status: 'success', output: expect.objectContaining({ content: 'You said: stream me (history 0)' }) })]);

        const page = await fetch(`${base}/apps/chat/chat`);
        expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'self' https://example.com");
        expect((await fetch(`${base}/apps/chat/nope`)).status).toBe(404);
      });
      expect(t.app.chat.sessions('chat').length).toBeGreaterThanOrEqual(3);
    } finally {
      await t.close();
    }
  });

  it('streams live run events for Studio test runs', async () => {
    const t = await createTestApp();
    try {
      await t.app.workspace.save('chat', 'Chat', chatFlow());
      await withHttp(t.app, async (base) => {
        const started = await jsonRequest(base)('/api/flows/chat/test', 'POST', { payload: { chatMessage: 'ping' } });
        expect(started.data.status).toBe('in-progress');
        const events = await readEvents(await fetch(`${base}/api/runs/${started.data.requestId}/events`));
        const types = events.map(([e, d]) => (e === 'trace' ? d.type : e));
        expect(types).toContain('run.start');
        expect(types).toContain('node.success');
        expect(events.at(-1)![0]).toBe('done');
        expect(events.at(-1)![1]).toMatchObject({ status: 'success', result: { content: 'echo:ping' } });
        const log = await jsonRequest(base)(`/api/runs/${started.data.requestId}`);
        expect(log.data).toMatchObject({ source: 'studio', status: 'success', output: { content: 'echo:ping' } });
        expect(log.data.nodes.find((n: { nodeId: string }) => n.nodeId === 'LLMNode_1').output.generatedResponse).toBe('echo:ping');
      });
    } finally {
      await t.close();
    }
  });

  it('serves the Studio shell and static assets with a strict CSP, and 404s unknown paths', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        for (const path of ['/', '/flows/abc', '/logs']) {
          const res = await fetch(base + path);
          expect(res.status).toBe(200);
          expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
        }
        expect((await fetch(`${base}/../package.json`)).status).toBe(404);
        expect((await fetch(`${base}/nothing-here.js`)).status).toBe(404);
      });
    } finally {
      await t.close();
    }
  });
});
