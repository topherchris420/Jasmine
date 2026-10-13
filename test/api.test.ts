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

describe('GraphQL API (Lamatic-compatible)', () => {
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

  it('serves POST /graphql with Lamatic-style auth (Bearer key + x-project-id, 403 on mismatch)', async () => {
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
