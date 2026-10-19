import { createHmac } from 'node:crypto';
import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/api/graphql.ts';
import { clientIp, RateLimiter } from '../src/api/http.ts';
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

const echoFlow = {
  nodes: [
    { id: 't', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
    { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{{t.output}}' } } },
  ],
  edges: [{ source: 't', target: 'r' }],
};
const fetchFlow = (path: string) => ({
  nodes: [
    { id: 't', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
    { id: 'call', data: { nodeId: 'apiNode', values: { url: `https://fixture.invalid/${path}`, method: 'GET' } } },
    { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{{call.output}}' } } },
  ],
  edges: [{ source: 't', target: 'call' }, { source: 'call', target: 'r' }],
});

describe('Execute keys and run records', () => {
  it('shows an execute key only the runs it started, without leaking other runs through errors', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('echo', echoFlow);
      const owner = t.app.apiKeys.create('Owner', 'admin').token;
      const appA = t.app.apiKeys.create('App A', 'execute');
      const appB = t.app.apiKeys.create('App B', 'execute').token;
      await withHttp(t.app, async (base) => {
        const asA = jsonRequest(base, { authorization: `Bearer ${appA.token}` });
        const asB = jsonRequest(base, { authorization: `Bearer ${appB}` });
        const gql = async (token: string, query: string, variables?: Record<string, unknown>) =>
          (await postJson(`${base}/graphql`, { query, variables }, { authorization: `Bearer ${token}` })).json() as Promise<any>;
        const mcp = (token: string, name: string, args: Record<string, unknown>) =>
          jsonRequest(base, { authorization: `Bearer ${token}` })('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

        const run = await asA('/api/v1/flows/echo/execute', 'POST', { payload: { note: 'private to A' } });
        expect(run.data.status).toBe('success');
        const id = run.data.requestId;
        const viaGraphQL = (await gql(appA.token, 'mutation { executeWorkflow(workflowId: "echo", payload: { note: "also A" }) { requestId } }')).data.executeWorkflow.requestId;
        expect(t.app.runStore.list({ flowId: 'echo' }).runs.map((r) => r.apiKeyId)).toEqual([appA.key.id, appA.key.id]);

        expect((await asA(`/api/v1/runs/${id}`)).data.input).toEqual({ note: 'private to A' });
        expect((await asA(`/api/v1/runs/${id}/trace`)).status).toBe(200);
        expect((await gql(appA.token, '{ runHistory(workflowId: "echo") { requestId } }')).data.runHistory.map((r: { requestId: string }) => r.requestId).sort()).toEqual([id, viaGraphQL].sort());

        const leaks = (value: unknown) => JSON.stringify(value).includes('private to A');
        for (const path of [`/api/v1/runs/${id}`, `/api/v1/runs/${id}/trace`, `/api/runs/${id}/events`]) {
          const res = await asB(path);
          expect(res.status, path).toBe(404);
          expect(res.data).toEqual({ errors: [{ message: `Request ${id} not found`, extensions: { code: 'NOT_FOUND', retryable: false } }] });
        }
        const retried = await asB(`/api/v1/runs/${id}/retry`, 'POST', {});
        expect(retried.status).toBe(404);
        expect(leaks(retried.data)).toBe(false);
        for (const query of ['query($id: String!) { checkStatus(requestId: $id) { status input } }', 'query($id: String!) { runTrace(requestId: $id) }', 'mutation($id: String!) { retryWorkflow(requestId: $id) { status input } }']) {
          const res = await gql(appB, query, { id });
          expect(res.errors[0].extensions.code, query).toBe('NOT_FOUND');
          expect(leaks(res), query).toBe(false);
        }
        expect((await gql(appB, '{ runHistory(workflowId: "echo") { requestId input } }')).data.runHistory).toEqual([]);
        const status = await mcp(appB, 'check_status', { requestId: id });
        expect(status.data.result.isError).toBe(true);
        expect(leaks(status.data)).toBe(false);
        expect(JSON.parse((await mcp(appA.token, 'check_status', { requestId: id })).data.result.content[0].text).input).toEqual({ note: 'private to A' });

        // Admin keys and Studio see every run.
        expect((await jsonRequest(base, { authorization: `Bearer ${owner}` })(`/api/v1/runs/${id}`)).data.input).toEqual({ note: 'private to A' });
        expect((await gql(owner, '{ runHistory(workflowId: "echo") { requestId } }')).data.runHistory).toHaveLength(2);
      });
    } finally {
      await t.close();
    }
  });

  it('keeps idempotency keys and cached responses from handing one key another key\'s run', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('echo', echoFlow);
      t.app.cache.configure('echo', { enabled: true, ttlSeconds: 600 });
      t.app.apiKeys.create('Owner', 'admin');
      const appA = t.app.apiKeys.create('App A', 'execute').token;
      const appB = t.app.apiKeys.create('App B', 'execute').token;
      await withHttp(t.app, async (base) => {
        const asA = jsonRequest(base, { authorization: `Bearer ${appA}` });
        const asB = jsonRequest(base, { authorization: `Bearer ${appB}` });
        const first = await asA('/api/v1/flows/echo/execute', 'POST', { payload: { n: 1 }, idempotencyKey: 'shared-key' });
        expect((await asA('/api/v1/flows/echo/execute', 'POST', { payload: { n: 1 }, idempotencyKey: 'shared-key' })).data.requestId).toBe(first.data.requestId);
        for (const payload of [{ n: 1 }, { n: 2 }]) {
          const reused = await asB('/api/v1/flows/echo/execute', 'POST', { payload, idempotencyKey: 'shared-key' });
          expect(reused.status).toBe(409);
          expect(JSON.stringify(reused.data)).not.toContain(first.data.requestId);
        }

        const cachedForA = await asA('/api/v1/flows/echo/execute', 'POST', { payload: { n: 3 } });
        expect((await asA('/api/v1/flows/echo/execute', 'POST', { payload: { n: 3 } })).data).toMatchObject({ cached: true, requestId: cachedForA.data.requestId });
        const forB = await asB('/api/v1/flows/echo/execute', 'POST', { payload: { n: 3 } });
        expect(forB.data.cached).toBeUndefined();
        expect(forB.data.requestId).not.toBe(cachedForA.data.requestId);
        expect((await asB(`/api/v1/runs/${forB.data.requestId}`)).data.status).toBe('success');
      });
    } finally {
      await t.close();
    }
  });

  it('lets an execute key retry and cancel only its own deployed runs', async () => {
    let healthy = false;
    let release = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const t = await createTestApp({
      fetch: fakeFetch(async (url) => {
        if (url.endsWith('/slow')) await slow;
        return healthy ? Response.json({ ok: true }) : new Response('down', { status: 503 });
      }),
    });
    try {
      await t.app.deployments.deploy('flaky', fetchFlow('flaky'));
      await t.app.deployments.deploy('slow', fetchFlow('slow'));
      t.app.apiKeys.create('Owner', 'admin');
      const appA = t.app.apiKeys.create('App A', 'execute').token;
      const appB = t.app.apiKeys.create('App B', 'execute').token;
      await withHttp(t.app, async (base) => {
        const asA = jsonRequest(base, { authorization: `Bearer ${appA}` });
        const asB = jsonRequest(base, { authorization: `Bearer ${appB}` });

        const failed = await asA('/api/v1/flows/flaky/execute', 'POST', { payload: {} });
        expect(failed.data.status).toBe('failed');
        healthy = true;
        expect((await asB(`/api/v1/runs/${failed.data.requestId}/retry`, 'POST', {})).status).toBe(404);
        const retried = await asA(`/api/v1/runs/${failed.data.requestId}/retry`, 'POST', {});
        expect(retried.data.status).toBe('success');
        expect((await asA(`/api/v1/runs/${retried.data.requestId}`)).data.status).toBe('success');

        // A Studio test run executes the undeployed draft; an execute key must not re-run it.
        healthy = false;
        const draft = t.app.runs.testPlan(t.app.deployments.preview('flaky-draft', fetchFlow('draft')).plan, {});
        expect((await t.app.runs.wait(draft.requestId)).status).toBe('failed');
        healthy = true;
        const runsBefore = t.app.runStore.list({ flowId: 'flaky-draft' }).runs.length;
        expect((await asA(`/api/v1/runs/${draft.requestId}/retry`, 'POST', {})).status).toBe(404);
        expect(t.app.runStore.list({ flowId: 'flaky-draft' }).runs).toHaveLength(runsBefore);

        const pending = await asA('/api/v1/flows/slow/execute', 'POST', { payload: {}, mode: 'async' });
        expect((await asB(`/api/v1/runs/${pending.data.requestId}/cancel`, 'POST', {})).data).toEqual({ cancelled: false });
        expect((await asB(`/api/runs/${pending.data.requestId}/cancel`, 'POST', {})).data).toEqual({ cancelled: false });
        expect((await asA(`/api/v1/runs/${pending.data.requestId}`)).data.status).toBe('in-progress');
        expect((await asA(`/api/v1/runs/${pending.data.requestId}/cancel`, 'POST', {})).data).toEqual({ cancelled: true });
      });
    } finally {
      release();
      await t.close();
    }
  });
});

/** node:http sends the Host header a DNS-rebinding page would carry; fetch always uses the URL's own host. */
function rawRequest(base: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const request = http.request(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, data: text ? JSON.parse(text) : null }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

describe('Keyless workspaces and browsers', () => {
  it('rejects cross-site writes and preflights while curl, the SDKs and Studio keep working', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        const body = JSON.stringify({ templateId: 'first-workflow' });
        // A text/plain POST is a "simple" request: a page on any site can send it without a preflight.
        const forged = await fetch(`${base}/api/flows`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'http://evil.example' }, body });
        expect(forged.status).toBe(403);
        expect(await forged.json()).toMatchObject({ errors: [{ extensions: { code: 'FORBIDDEN', retryable: false } }] });
        expect((await fetch(`${base}/api/flows`, { method: 'POST', headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' }, body })).status).toBe(403);
        expect((await fetch(`${base}/api/flows`, { method: 'POST', headers: { origin: 'null' }, body })).status).toBe(403);
        expect((await postJson(`${base}/graphql`, { query: HEALTH_QUERY }, { origin: 'http://evil.example' })).status).toBe(403);
        expect(t.app.workspace.list()).toHaveLength(0);

        // Non-browser clients send no Origin; Studio sends its own.
        expect((await jsonRequest(base)('/api/flows', 'POST', { templateId: 'first-workflow' })).status).toBe(201);
        expect((await jsonRequest(base, { origin: base, 'sec-fetch-site': 'same-origin' })('/api/flows', 'POST', { templateId: 'first-workflow' })).status).toBe(201);
        expect((await jsonRequest(base, { origin: 'http://evil.example' })('/api/flows')).status).toBe(200);

        const preflight = (origin: string, path = '/api/flows') => fetch(`${base}${path}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
        for (const path of ['/api/flows', '/graphql', '/api/v1/flows/x/execute', '/nothing-here']) {
          const denied = await preflight('http://evil.example', path);
          expect(denied.status).toBe(403);
          expect(denied.headers.get('access-control-allow-origin')).toBeNull();
          expect(await denied.json()).toMatchObject({ errors: [{ extensions: { code: 'FORBIDDEN' } }] });
        }
        const own = await preflight(base);
        expect(own.status).toBe(204);
        expect(own.headers.get('access-control-allow-origin')).toBe(base);
      });
    } finally {
      await t.close();
    }
  });

  it('answers only loopback names, PUBLIC_URL and JASMINE_ALLOWED_HOSTS until an admin key exists', async () => {
    const t = await createTestApp({ env: { LLM_PROVIDER: 'mock', PUBLIC_URL: 'https://studio.example', JASMINE_ALLOWED_HOSTS: 'jasmine.lan, 192.168.1.20:8787' } });
    try {
      await withHttp(t.app, async (base) => {
        const port = new URL(base).port;
        for (const host of ['evil.example', `evil.example:${port}`, '0.0.0.0', 'jasmine.lan.evil.example', 'localhost.evil.example', '127.0.0.1.evil.example', 'bad host']) {
          const res = await rawRequest(base, '/api/settings', { host });
          expect(res.status, host).toBe(403);
          expect(res.data.errors[0].extensions.code).toBe('FORBIDDEN');
          expect(res.data.errors[0].message).toContain('JASMINE_ALLOWED_HOSTS');
        }
        expect((await rawRequest(base, '/', { host: 'evil.example' })).status).toBe(403);
        for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `studio.localhost:${port}`, `[::1]:${port}`, 'studio.example', `jasmine.lan:${port}`, '192.168.1.20']) {
          expect((await rawRequest(base, '/api/settings', { host })).status, host).toBe(200);
        }
        // Health checks address the container or host by any name.
        expect((await rawRequest(base, '/healthz', { host: 'jasmine:8787' })).status).toBe(200);
        // Behind a TLS proxy the page's own origin is https:// on an allowed name; another site still is not.
        const write = (origin: string) => rawRequest(base, '/api/flows', { host: 'jasmine.lan', origin, 'content-type': 'application/json' }, JSON.stringify({ templateId: 'first-workflow' }));
        expect((await write('https://jasmine.lan')).status).toBe(201);
        expect((await write('https://evil.example')).status).toBe(403);

        // A page cannot know an API key, so a request carrying a valid one may use any name, even before an admin key exists.
        const { token: execute } = t.app.apiKeys.create('app', 'execute');
        expect((await rawRequest(base, '/api/v1/runs/unknown-run', { host: 'jasmine:8787', authorization: `Bearer ${execute}` })).status).toBe(404);
        expect((await rawRequest(base, '/api/v1/runs/unknown-run', { host: 'jasmine:8787', authorization: 'Bearer jsm_x_wrong' })).status).toBe(403);
        expect((await rawRequest(base, '/api/settings', { host: 'jasmine:8787' })).status).toBe(403);

        // Once a key protects the workspace, Docker service names and LAN addresses work with it.
        const { token } = t.app.apiKeys.create('owner', 'admin');
        expect((await rawRequest(base, '/api/settings', { host: 'jasmine:8787', authorization: `Bearer ${token}` })).status).toBe(200);
        expect((await rawRequest(base, '/api/settings', { host: 'jasmine:8787' })).status).toBe(403);
      });
    } finally {
      await t.close();
    }
  });

  it('answers widget preflights only for the sites the trigger allows', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('cors-chat', chatFlow(['example.com']));
      await t.app.deployments.deploy('cors-open', chatFlow());
      await withHttp(t.app, async (base) => {
        const preflight = (path: string, origin: string) => fetch(`${base}${path}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
        const allowed = await preflight('/api/chat/cors-chat', 'https://example.com');
        expect(allowed.status).toBe(204);
        expect(allowed.headers.get('access-control-allow-origin')).toBe('https://example.com');
        expect(allowed.headers.get('access-control-allow-headers')).toContain('content-type');
        expect(allowed.headers.get('access-control-allow-headers')).not.toContain('authorization');
        expect((await preflight('/api/chat/cors-chat/config', 'https://example.com')).status).toBe(204);
        expect((await preflight('/api/chat/cors-chat', 'https://evil.example')).status).toBe(403);
        expect((await preflight('/api/chat/missing', 'https://example.com')).status).toBe(404);
        expect((await preflight('/api/chat/cors-open', 'https://anywhere.example')).headers.get('access-control-allow-origin')).toBe('https://anywhere.example');
        expect((await preflight('/webhooks/cors-open', 'https://anywhere.example')).status).toBe(204);
      });
    } finally {
      await t.close();
    }
  });
});

describe('Rate limits', () => {
  it('evicts the oldest windows when full instead of resetting every client at once', () => {
    const limiter = new RateLimiter(1, 60_000);
    for (let i = 0; i <= 10_001; i++) expect(limiter.allow(`client-${i}`)).toBe(true);
    // A flood of new addresses must not hand the clients already at their limit a fresh window.
    expect(limiter.allow('client-5000')).toBe(false);
    expect(limiter.allow('client-10001')).toBe(false);
  });

  it('drops expired windows before active ones', () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(1, 1_000, 3);
      limiter.allow('expired-1');
      limiter.allow('expired-2');
      vi.advanceTimersByTime(2_000);
      expect(limiter.allow('active')).toBe(true);
      limiter.allow('new-1');
      limiter.allow('new-2');
      expect(limiter.allow('active')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts an IPv6 client by its /64 network and an IPv4-mapped address as IPv4', () => {
    const from = (remoteAddress: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress } }) as unknown as http.IncomingMessage;
    expect(clientIp(from('2001:db8:1:2::1'))).toBe(clientIp(from('2001:0db8:0001:0002:ffff:ffff:ffff:5')));
    expect(clientIp(from('2001:db8:1:2::1'))).not.toBe(clientIp(from('2001:db8:1:3::1')));
    expect(clientIp(from('::1'))).toBe(clientIp(from('::2')));
    expect(clientIp(from('::ffff:203.0.113.7'))).toBe('203.0.113.7');
    expect(clientIp(from('203.0.113.7'))).toBe('203.0.113.7');
    expect(clientIp(from('10.0.0.1', { 'x-jasmine-client-ip': '2001:db8:1:2::9' }), true)).toBe(clientIp(from('2001:db8:1:2::1')));
    expect(clientIp(from('10.0.0.1', { 'x-jasmine-client-ip': '2001:db8:1:2::9' }))).toBe('10.0.0.1');
    expect(clientIp(from('10.0.0.1', { 'x-jasmine-client-ip': 'not an address' }), true)).toBe('10.0.0.1');
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
