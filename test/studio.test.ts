import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api/graphql.ts';
import { createServer } from '../src/api/server.ts';
import { importStudioFlow } from '../src/flow/import.ts';
import { defaultRegistry } from '../src/nodes/builtin.ts';
import { DeploymentRegistry } from '../src/service/deployments.ts';
import { RunService } from '../src/service/runs.ts';
import { WorkspaceStore } from '../src/service/workspace.ts';
import { makeServices, studioArticleSummariser } from './helpers.ts';

describe('Studio backend', () => {
  it('protects drafts, saves empty drafts, rejects stale updates, and preserves a deployment after invalid edits', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jasmine-studio-'));
    const workspace = new WorkspaceStore(directory); await workspace.load();
    const deployments = new DeploymentRegistry(defaultRegistry());
    const runs = new RunService(deployments, { services: makeServices() });
    const server = createServer(createApi(deployments, runs), { apiKey: 'classroom-test-key', studio: { workspace, deployments, runs, model: 'mock', provider: 'mock' } }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (url: string, method = 'GET', body?: unknown) => fetch(base + url, { method, headers: { authorization: 'Bearer classroom-test-key', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      expect((await fetch(base + '/api/studio')).status).toBe(403);
      expect((await fetch(base + '/studio')).status).toBe(200);
      expect((await request('/api/studio/flows/empty', 'PUT', { name: 'Empty draft', definition: { nodes: [], edges: [] }, expectedRevision: 0 })).status).toBe(200);
      expect((await request('/api/studio/flows/empty/deploy', 'POST', {})).status).toBe(400);
      const definition = studioArticleSummariser();
      expect((await request('/api/studio/flows/article', 'PUT', { name: 'Article', definition, expectedRevision: 0 })).status).toBe(200);
      expect((await request('/api/studio/flows/article/deploy', 'POST', {})).status).toBe(200);
      const version = deployments.getActive('article')!.version;
      expect((await request('/api/studio/flows/article', 'PUT', { name: 'Stale', definition, expectedRevision: 0 })).status).toBe(409);
      definition.nodes[1]!.data.nodeId = 'unsupportedNode';
      expect((await request('/api/studio/flows/article', 'PUT', { name: 'Invalid edit', definition, expectedRevision: 1 })).status).toBe(200);
      expect((await request('/api/studio/flows/article/deploy', 'POST', {})).status).toBe(400);
      expect(deployments.getActive('article')!.version).toBe(version);
      const restored = new WorkspaceStore(directory); await restored.load();
      expect(restored.get('article')?.deployedVersion).toBe(version);
      expect((restored.get('article')?.deployedDefinition as ReturnType<typeof studioArticleSummariser>).nodes[1]?.data.nodeId).toBe('apiNode');
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves explicit condition branches when edges are listed in a different order', () => {
    const definition = { nodes: [
      { id: 'condition', data: { nodeId: 'conditionNode', values: { conditions: [{ value: 'yes' }, { value: 'else' }] } } },
      { id: 'first', data: { nodeId: 'variablesNode', values: {} } },
      { id: 'second', data: { nodeId: 'variablesNode', values: {} } },
    ], edges: [
      { source: 'condition', target: 'first', type: 'conditionEdge', branch: 'else' },
      { source: 'condition', target: 'second', type: 'conditionEdge', sourceHandle: 'yes' },
    ] };
    const imported = importStudioFlow(definition, { flowId: 'flow' });
    expect(imported.definition.edges.map((edge) => edge.branch)).toEqual(['else', 'yes']);
    expect(imported.diagnostics).toEqual([]);
  });

  it('preserves explicit engine execution policy and rejects invalid policies', () => {
    const definition = studioArticleSummariser();
    const policy = { timeoutMs: 100, retry: { maxAttempts: 2, delayMs: 0, backoff: 'fixed', jitter: false } };
    const node = definition.nodes[1]!.data as typeof definition.nodes[1]['data'] & { engineLogic?: unknown };
    node.engineLogic = policy;
    expect(importStudioFlow(definition, { flowId: 'flow' }).definition.nodes[1]?.logic).toEqual(policy);
    node.engineLogic = { timeoutMs: -1 };
    expect(() => importStudioFlow(definition, { flowId: 'flow' })).toThrow('Invalid execution policy');
  });
});
