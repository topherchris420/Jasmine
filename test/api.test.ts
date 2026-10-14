import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api/graphql.ts';
import { createServer } from '../src/api/server.ts';
import { MockLLMProvider } from '../src/llm/providers.ts';
import { defaultRegistry } from '../src/nodes/builtin.ts';
import { DeploymentRegistry } from '../src/service/deployments.ts';
import { RunService } from '../src/service/runs.ts';
import { fakeFetch, makeServices, studioArticleSummariser } from './helpers.ts';

function setup() {
  const http = fakeFetch(() => new Response('Long article text…', { headers: { 'content-type': 'text/plain' } }));
  const llm = new MockLLMProvider({ respond: () => 'He said "fine".\nShort summary.' });
  const deployments = new DeploymentRegistry(defaultRegistry());
  const runs = new RunService(deployments, { services: makeServices(llm, http) });
  return { api: createApi(deployments, runs), http };
}

const DEPLOY = `mutation Deploy($def: JSON!) { deployFlow(workflowId: "article", definition: $def) { version changed diagnostics { code } } }`;
const EXECUTE = `query Run($wf: String!, $p: JSON) { executeWorkflow(workflowId: $wf, payload: $p) { status requestId result error { code message nodeId } } }`;

describe('GraphQL API (Jasmine)', () => {
  it('deploys a Studio export and executes it with executeWorkflow', async () => {
    const { api, http } = setup();
    const deployed = await api.execute(DEPLOY, { def: studioArticleSummariser() });
    expect(deployed.errors).toBeUndefined();
    const res = await api.execute(EXECUTE, { wf: 'article', p: { url: 'https://news.example/a' } });
    const data = res.data!['executeWorkflow'] as { status: string; requestId: string; result: { output: unknown; nodes: unknown[]; statusCode: number } };
    expect(data.status).toBe('success');
    expect(data.result.output).toEqual({ summary: 'He said "fine".\nShort summary.' });
    expect(data.result.statusCode).toBe(200);
    expect(data.result.nodes).toHaveLength(4);
    expect(http.calls[0]?.url).toBe('https://news.example/a');

    const status = await api.execute(`query { checkStatus(requestId: "${data.requestId}") { status } }`);
    expect(status.data).toEqual({ checkStatus: { status: 'success' } });
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

  it('serves POST /graphql with Jasmine authentication (Bearer key + x-project-id, 403 on mismatch)', async () => {
    const { api } = setup();
    const server = createServer(api, { apiKey: 'test-key', projectId: 'proj-1' }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
    const post = (headers: Record<string, string>) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ query: '{ flowVersions(workflowId: "x") { version } }' }) });
    try {
      expect((await post({})).status).toBe(403);
      expect((await post({ authorization: 'Bearer test-key' })).status).toBe(403);
      const ok = await post({ authorization: 'Bearer test-key', 'x-project-id': 'proj-1' });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ data: { flowVersions: [] } });
    } finally {
      server.close();
    }
  });
});


const HEALTH_QUERY = '{ flowVersions(workflowId: "x") { version } }';

async function withServer(api: ReturnType<typeof createApi>, run: (url: string, server: http.Server) => Promise<void>, maxBodyBytes = 1024) {
  const server = createServer(api, { maxBodyBytes }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/graphql';
  try {
    await run(url, server);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

const postJson = (url: string, body: unknown) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function expectHealthy(url: string) {
  const response = await postJson(url, { query: HEALTH_QUERY });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { flowVersions: [] } });
}

describe('HTTP request resilience', () => {
  it('rejects invalid envelopes and fields, then accepts valid requests', async () => {
    await withServer(setup().api, async (url) => {
      for (const body of [null, [], 'text', 42, true, {}, { query: 3 },
        ...[[], 'bad', 1, false].map((variables) => ({ query: HEALTH_QUERY, variables })),
        ...[{}, [], 1, false].map((operationName) => ({ query: HEALTH_QUERY, operationName }))]) {
        const response = await postJson(url, body);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ errors: [{ extensions: { code: 'BAD_REQUEST' } }] });
      }
      const malformed = await fetch(url, { method: 'POST', body: '{bad json' });
      expect(malformed.status).toBe(400);
      const nullable = await postJson(url, { query: HEALTH_QUERY, variables: null, operationName: null });
      expect(nullable.status).toBe(200);
      expect(await nullable.json()).toEqual({ data: { flowVersions: [] } });
      await expectHealthy(url);
    });
  });

  it('returns 413 for an oversized body without losing the response or server', async () => {
    await withServer(setup().api, async (url) => {
      const response = await postJson(url, { query: HEALTH_QUERY, padding: 'x'.repeat(2048) });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ errors: [{ extensions: { code: 'PAYLOAD_TOO_LARGE' } }] });
      await expectHealthy(url);
    });
  });

  it('contains unexpected execution rejections without exposing their details', async () => {
    const api = setup().api;
    const execute = api.execute;
    let rejectNext = true;
    api.execute = (...args) => {
      if (rejectNext) {
        rejectNext = false;
        return Promise.reject(new Error('secret internal backend detail'));
      }
      return execute(...args);
    };
    await withServer(api, async (url) => {
      const response = await postJson(url, { query: HEALTH_QUERY });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ errors: [{ message: 'Internal server error', extensions: { code: 'INTERNAL_ERROR' } }] });
      await expectHealthy(url);
    });
  });

  it('survives a client disconnect in the middle of its request body', async () => {
    await withServer(setup().api, async (url, server) => {
      await new Promise<void>((resolve, reject) => {
        server.once('request', (incoming) => {
          incoming.once('close', resolve);
          incoming.once('data', () => request.destroy());
        });
        const request = http.request(url, { method: 'POST', headers: { 'content-length': 100 } });
        request.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ECONNRESET') reject(error);
        });
        request.write('{');
      });
      await expectHealthy(url);
    });
  });
});
