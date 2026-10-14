import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importStudioFlow } from '../src/flow/import.ts';
import { createTestApp, jsonRequest, studioArticleSummariser, withHttp } from './helpers.ts';

describe('Studio backend', () => {
  it('protects drafts, rejects stale updates, keeps the deployment after invalid edits, and survives a restart', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'jasmine-studio-'));
    try {
      let version: string;
      {
        const t = await createTestApp({ dataDir, inMemory: false });
        await withHttp(t.app, async (base) => {
          const req = jsonRequest(base);
          expect((await req('/api/flows/empty', 'PUT', { name: 'Empty draft', definition: { nodes: [], edges: [] }, expectedRevision: 0 })).status).toBe(200);
          expect((await req('/api/flows/empty/deploy', 'POST', {})).status).toBe(400);
          const definition = studioArticleSummariser();
          expect((await req('/api/flows/article', 'PUT', { name: 'Article', definition, expectedRevision: 0 })).status).toBe(200);
          const deployed = await req('/api/flows/article/deploy', 'POST', {});
          expect(deployed.status).toBe(200);
          version = deployed.data.version;
          expect((await req('/api/flows/article', 'PUT', { name: 'Stale', definition, expectedRevision: 0 })).status).toBe(409);
          definition.nodes[1]!.data.nodeId = 'unsupportedNode';
          expect((await req('/api/flows/article', 'PUT', { name: 'Invalid edit', definition, expectedRevision: 1 })).status).toBe(200);
          const failed = await req('/api/flows/article/deploy', 'POST', {});
          expect(failed.status).toBe(400);
          expect(failed.data.errors[0].extensions.diagnostics.map((d: { code: string }) => d.code)).toContain('UNSUPPORTED_NODE_TYPE');
          expect(t.app.deployments.getActive('article')!.version).toBe(version);
          const flows = (await req('/api/flows')).data as { id: string; deployedVersion: string | null; draftChanged: boolean }[];
          expect(flows.find((f) => f.id === 'article')).toMatchObject({ deployedVersion: version, draftChanged: true });
        });
        await t.close();
      }
      const restarted = await createTestApp({ dataDir, inMemory: false });
      try {
        expect(restarted.app.deployments.getActive('article')?.version).toBe(version!);
        expect(restarted.app.workspace.get('article')?.name).toBe('Invalid edit');
        expect(restarted.app.deployments.deployHistory('article').map((h) => h.action)).toEqual(['deploy']);
      } finally {
        await restarted.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('creates flows from templates, validates, versions, rolls back and deletes them', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        const req = jsonRequest(base);
        const templates = (await req('/api/templates')).data as { id: string }[];
        expect(templates.map((x) => x.id)).toEqual(expect.arrayContaining(['getting-started', 'knowledge-qa', 'support-router', 'research-agent']));
        for (const template of templates) {
          const created = await req('/api/flows', 'POST', { templateId: template.id });
          expect(created.status).toBe(201);
          const validation = await req(`/api/flows/${created.data.id}/validate`, 'POST', {});
          expect(validation.data.ok, `${template.id}: ${JSON.stringify(validation.data.diagnostics)}`).toBe(true);
        }
        const flow = (await req('/api/flows', 'POST', { templateId: 'getting-started', name: 'Support bot' })).data;
        expect(flow.id).toBe('support-bot');
        const v1 = (await req(`/api/flows/${flow.id}/deploy`, 'POST', {})).data.version;
        const draft = (await req(`/api/flows/${flow.id}`)).data;
        draft.definition.nodes[1].data.values.prompts[0].content = 'Be terse.';
        await req(`/api/flows/${flow.id}`, 'PUT', { name: draft.name, definition: draft.definition, expectedRevision: draft.revision });
        const v2 = (await req(`/api/flows/${flow.id}/deploy`, 'POST', {})).data.version;
        expect(v2).not.toBe(v1);
        const versions = (await req(`/api/flows/${flow.id}/versions`)).data;
        expect(versions.active).toBe(v2);
        expect(versions.versions).toHaveLength(2);
        expect((await req(`/api/flows/${flow.id}/rollback`, 'POST', { toVersion: v1 })).data).toMatchObject({ version: v1, changed: true });
        expect((await req(`/api/flows/${flow.id}/versions`)).data.history.map((h: { action: string }) => h.action)).toEqual(['rollback', 'deploy', 'deploy']);
        expect((await req(`/api/flows/${flow.id}/undeploy`, 'POST', {})).data).toEqual({ undeployed: true });
        expect((await req(`/api/flows/${flow.id}`, 'DELETE')).data).toEqual({ deleted: true });
        expect((await req(`/api/flows/${flow.id}`)).status).toBe(404);
      });
    } finally {
      await t.close();
    }
  });

  it('imports AgentKit flow modules as text and inlines kit prompt and script files', async () => {
    const t = await createTestApp();
    try {
      const nodes = [
        { id: 'triggerNode_1', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: { responeType: 'realtime', advance_schema: '{"q":"string"}' } } },
        { id: 'LLMNode_1', type: 'dynamicNode', data: { nodeId: 'LLMNode', values: { prompts: [{ role: 'system', content: '@prompts/demo_system.md' }, { role: 'user', content: '{{triggerNode_1.output.q}}' }], generativeModelName: '@model-configs/demo.ts' } } },
        { id: 'codeNode_1', type: 'dynamicNode', data: { nodeId: 'codeNode', values: { code: '@scripts/demo_code.ts' } } },
        { id: 'responseNode_triggerNode_1', type: 'responseNode', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"a":"{{codeNode_1.output.answer}}"}' } } },
      ];
      const edges = [
        { id: 'e1', source: 'triggerNode_1', target: 'LLMNode_1', type: 'defaultEdge' }, { id: 'e2', source: 'LLMNode_1', target: 'codeNode_1', type: 'defaultEdge' },
        { id: 'e3', source: 'codeNode_1', target: 'responseNode_triggerNode_1', type: 'defaultEdge' },
        { id: 'response-x', source: 'triggerNode_1', target: 'responseNode_triggerNode_1', type: 'responseEdge', sourceHandle: 'to-response', targetHandle: 'from-trigger' },
      ];
      const text = `export const meta = { name: "Demo kit", description: "x" };\nexport const nodes = ${JSON.stringify(nodes, null, 2)};\nexport const edges = ${JSON.stringify(edges)};\nexport default { meta, nodes, edges };\n`;
      await withHttp(t.app, async (base) => {
        const res = await jsonRequest(base)('/api/flows/import', 'POST', {
          text, refs: { '@prompts/demo_system.md': 'You are terse.', '@scripts/demo_code.ts': '// helper\noutput = { answer: {{LLMNode_1.output.generatedResponse}} };' },
        });
        expect(res.status).toBe(201);
        expect(res.data.flow).toMatchObject({ id: 'demo-kit', name: 'Demo kit' });
        expect(res.data.validation.ok).toBe(true);
        expect(res.data.validation.diagnostics.map((d: { code: string }) => d.code)).toContain('IMPORT_MODEL_UNSET');
        await t.app.deployFlow('demo-kit');
        const run = await t.app.runs.executeWorkflow('demo-kit', { q: 'hi' });
        expect(run.output).toEqual({ a: 'echo:You are terse.\nhi' });
      });
    } finally {
      await t.close();
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
