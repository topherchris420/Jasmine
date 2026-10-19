import { describe, expect, it } from 'vitest';
import { diffDefinitions } from '../src/service/assistant.ts';
import { explainError } from '../src/service/explain.ts';
import { createTestApp, fakeFetch, jsonRequest, withHttp } from './helpers.ts';

async function fromTemplate(t: Awaited<ReturnType<typeof createTestApp>>, templateId: string, id: string) {
  const template = (await t.app.templates()).find((x) => x.id === templateId)!;
  return t.app.workspace.save(id, template.name, structuredClone(template.definition));
}

describe('Copilot grounded in the workspace', () => {
  it('diagnoses with Jasmine’s own checks and explains the flow step by step, even without a real model', async () => {
    const t = await createTestApp();
    try {
      await fromTemplate(t, 'knowledge-qa', 'qa');
      const diagnosis = await t.app.assistant.ask({ flowId: 'qa', action: 'diagnose' });
      expect(diagnosis.model).toBeNull();
      expect(diagnosis.text).toContain('need');
      expect(diagnosis.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'missing', title: 'Create the “handbook” collection', action: expect.objectContaining({ href: '/context?tab=knowledge&create=handbook' }) }),
        expect.objectContaining({ status: 'warning', title: 'Using demonstration responses' }),
      ]));
      const explained = await t.app.assistant.ask({ flowId: 'qa', action: 'explain' });
      expect(explained.text.split('\n')[1]).toMatch(/^1\. API Request \(API Request\): Starts the workflow when your app sends a request/);
      expect(explained.text).toContain('2. RAG (RAG): Searches your documents');
      const free = await t.app.assistant.ask({ flowId: 'qa', message: 'Make this better', propose: true });
      expect(free).toMatchObject({ note: expect.stringContaining('Free-form changes need a connected model') });
      expect(free).not.toHaveProperty('proposal');
      const capabilities = await t.app.assistant.ask({ flowId: 'qa', action: 'capabilities' });
      expect(capabilities.text).toContain('No real chat model is connected');
      expect(capabilities.ideas?.[0]?.label).toBe('A JSON API with no model');
    } finally {
      await t.close();
    }
  });

  it('includes the latest run failure, with its cause and recovery, in the diagnosis', async () => {
    const t = await createTestApp();
    try {
      await fromTemplate(t, 'knowledge-qa', 'qa');
      const { plan } = t.app.deployments.preview('qa', t.app.workspace.get('qa')!.definition);
      const run = await t.app.runs.wait(t.app.runs.testPlan(plan, { question: 'Where is the handbook?' }).requestId);
      expect(run.status).toBe('failed');
      const diagnosis = await t.app.assistant.ask({ flowId: 'qa', action: 'diagnose' });
      expect(diagnosis.findings[0]).toMatchObject({ status: 'error', title: 'Last run failed: The “handbook” collection doesn’t exist', nodeIds: ['RAGNode_1'] });
      await withHttp(t.app, async (base) => {
        const detail = (await jsonRequest(base)(`/api/runs/${run.requestId}`)).data;
        expect(detail.error.code).toBe('NOT_FOUND');
        expect(detail.explanation).toMatchObject({ component: 'Step “RAG”', title: 'The “handbook” collection doesn’t exist', actions: [{ href: '/context?tab=knowledge&create=handbook' }] });
        expect(detail.nodeExplanations.RAGNode_1.code).toBe('NOT_FOUND');
      });
    } finally {
      await t.close();
    }
  });

  it('proposes document retrieval as a validated diff, applies it only on request, records it and reverts it', async () => {
    const t = await createTestApp();
    try {
      const original = await fromTemplate(t, 'getting-started', 'chat');
      t.app.vectors.createCollection({ name: 'handbook', kind: 'knowledge' });
      const answer = await t.app.assistant.ask({ flowId: 'chat', action: 'add-retrieval' });
      expect(t.app.workspace.get('chat')!.revision).toBe(original.revision);
      const proposal = answer.proposal!;
      expect(proposal.validation.ok).toBe(true);
      expect(proposal.changes.added).toEqual([{ id: 'retrieve', type: 'hybridSearchNode', name: 'Find relevant passages' }]);
      expect(proposal.changes.modified).toEqual([expect.objectContaining({ id: 'LLMNode_1', fields: ['prompts'] })]);
      expect(proposal.changes.summary).toContain('adds “Find relevant passages”');
      const applied = await t.app.assistant.apply('chat', { definition: proposal.definition, expectedRevision: proposal.expectedRevision, summary: proposal.summary });
      expect(applied.revision).toBe(original.revision + 1);
      const { plan } = t.app.deployments.preview('chat', applied.definition);
      const run = await t.app.runs.wait(t.app.runs.testPlan(plan, { chatMessage: 'hello', chatHistory: [] }).requestId);
      expect(run.status).toBe('success');
      const history = t.app.assistant.history('chat');
      expect(history).toEqual([expect.objectContaining({ kind: 'apply', summary: 'Add document retrieval from “handbook”', fromRevision: 1, toRevision: 2 })]);
      const raw = t.app.db.get<{ payload: string }>('SELECT payload FROM assistant_changes')!.payload;
      expect(raw.startsWith('enc:v1:')).toBe(true);
      expect(raw).not.toContain('retrieve');
      await expect(t.app.assistant.revert('chat', history[0]!.id, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
      const reverted = await t.app.assistant.revert('chat', history[0]!.id, applied.revision);
      expect(reverted.definition).toEqual(original.definition);
      expect(t.app.assistant.history('chat').map((h) => h.kind)).toEqual(['revert', 'apply']);
      await t.app.deleteFlow('chat');
      expect(t.app.assistant.history('chat')).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it('sends a real model the grounded context but never credentials, API keys or secrets', async () => {
    const bodies: string[] = [];
    const fetch = fakeFetch((url, init) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'local-chat' }] });
      bodies.push(String(init.body));
      return Response.json({ model: 'local-chat', choices: [{ finish_reason: 'stop', message: { content: 'Upload documents to the handbook collection first.' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
    });
    const t = await createTestApp({ fetch });
    try {
      t.app.connections.upsert({ id: 'local', name: 'Local', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'sk-connection-key-0001' });
      t.app.connections.setDefaults({ chat: 'local' });
      t.app.credentials.upsert({ integration: 'slack', name: 'team', data: { token: 'xoxb-credential-secret-9' } });
      t.app.project.setSecret('PROVIDER_TOKEN', 'project-secret-value-77');
      await fromTemplate(t, 'knowledge-qa', 'qa');
      const draft = t.app.workspace.get('qa')!;
      const def = draft.definition as { nodes: { data: { values: Record<string, unknown> } }[] };
      def.nodes[1]!.data.values['prompts'] = [{ role: 'system', content: 'Use key project-secret-value-77 carefully' }];
      await t.app.workspace.save('qa', draft.name, def, draft.revision);
      const answer = await t.app.assistant.ask({ flowId: 'qa', message: 'Why isn’t this workflow working?' });
      expect(answer.text).toBe('Upload documents to the handbook collection first.');
      expect(answer.model).toBe('local-chat');
      const sent = bodies.join('\n');
      expect(sent).toContain('Create the “handbook” collection');
      expect(sent).toContain('slack');
      for (const secret of ['sk-connection-key-0001', 'xoxb-credential-secret-9', 'project-secret-value-77']) expect(sent).not.toContain(secret);
    } finally {
      await t.close();
    }
  });

  it('reports a flow’s lifecycle as Draft, Validated, Deployed, Failed or Disabled', async () => {
    const t = await createTestApp();
    try {
      const empty = await t.app.workspace.save('empty', 'Empty', { nodes: [], edges: [] });
      expect(t.app.flowSummary(empty).lifecycle.state).toBe('draft');
      const first = await fromTemplate(t, 'first-workflow', 'first');
      expect(t.app.flowSummary(first).lifecycle).toMatchObject({ state: 'validated', label: 'Validated' });
      await t.app.deployFlow('first');
      expect(t.app.flowSummary(t.app.workspace.get('first')!).lifecycle.state).toBe('deployed');
      await t.app.runs.executeWorkflow('first', { message: 42 });
      expect(t.app.flowSummary(t.app.workspace.get('first')!).lifecycle).toMatchObject({ state: 'failed', detail: expect.stringContaining('latest run failed') });
      await t.app.runs.executeWorkflow('first', { message: 'hi' });
      expect(t.app.flowSummary(t.app.workspace.get('first')!).lifecycle.state).toBe('deployed');
      t.app.deployments.undeploy('first');
      expect(t.app.flowSummary(t.app.workspace.get('first')!).lifecycle.state).toBe('disabled');
      const broken = await t.app.workspace.save('broken', 'Broken', { nodes: [{ id: 'x', type: 'dynamicNode', data: { nodeId: 'nope', values: {} } }], edges: [] });
      await expect(t.app.deployFlow('broken')).rejects.toMatchObject({ code: 'COMPILE' });
      expect(t.app.flowSummary(broken).lifecycle).toMatchObject({ state: 'failed', detail: expect.stringContaining('Deploy failed') });
    } finally {
      await t.close();
    }
  });

  it('explains common failures with the failed component and a recovery path', () => {
    expect(explainError({ code: 'NETWORK', message: 'Cannot reach Ollama at http://127.0.0.1:11434; run `ollama serve` or fix the connection URL' }, { nodeId: 'a', nodeName: 'Write the reply', nodeLabel: 'Generate Text', nodeType: 'LLMNode' }))
      .toMatchObject({ title: 'Jasmine couldn’t reach your model server', component: 'Step “Write the reply” (Generate Text)', actions: [{ href: '/models?diagnose=http%3A%2F%2F127.0.0.1%3A11434' }] });
    expect(explainError({ code: 'PROVIDER', message: 'Local model server ended the streamed reply before it finished; check the server\'s log' }, { nodeType: 'RAGNode' }).title).toBe('Your model server stopped mid-reply');
    expect(explainError({ code: 'PROVIDER', message: 'Local model server returned HTTP 500' }, { nodeType: 'agentClassifierNode' }))
      .toMatchObject({ title: 'Your model server reported an error', actions: [{ href: '/models?diagnose=default' }] });
    expect(explainError({ code: 'BAD_PAYLOAD', message: 'Invalid trigger payload: $.message: expected string' }).title).toBe('The input doesn’t match what the workflow expects');
    expect(explainError({ code: 'TIMEOUT', message: 'x' }, { nodeType: 'LLMNode' }).steps[0]).toContain('smaller or faster model');
    expect(explainError({ code: 'PROVIDER', message: 'Local model response exceeded its token limit; raise maxTokens' }).title).toBe('The answer was cut off');
    expect(explainError({ code: 'TEMPLATE_UNRESOLVED', message: '{{a.output.b}} is undefined' }).title).toContain('reference');
    expect(explainError(undefined)).toMatchObject({ code: 'ERROR', component: 'The workflow', fixable: false });
  });

  it('summarizes structural differences between definitions', () => {
    const before = { nodes: [{ id: 'a', data: { nodeId: 'graphqlNode', values: { nodeName: 'In' } } }, { id: 'b', data: { nodeId: 'LLMNode', values: { nodeName: 'Write', prompts: [] } } }], edges: [{ source: 'a', target: 'b' }] };
    const after = { nodes: [{ id: 'a', data: { nodeId: 'graphqlNode', values: { nodeName: 'In' } } }, { id: 'c', data: { nodeId: 'graphqlResponseNode', values: { nodeName: 'Out' } } }], edges: [{ source: 'a', target: 'c' }] };
    expect(diffDefinitions(before, after)).toMatchObject({ added: [{ id: 'c' }], removed: [{ id: 'b' }], edgesAdded: [{ source: 'a', target: 'c' }], edgesRemoved: [{ source: 'a', target: 'b' }], summary: 'This adds “Out”; removes “Write”; rewires 2 connections.' });
  });
});
