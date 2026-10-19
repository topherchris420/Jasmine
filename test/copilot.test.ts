import { describe, expect, it } from 'vitest';
import { diffDefinitions, maskSecretPairs, restoreMasked } from '../src/service/assistant.ts';
import { explainError } from '../src/service/explain.ts';
import { logValue } from '../src/service/runlog.ts';
import { createTestApp, fakeFetch, jsonRequest, withHttp } from './helpers.ts';

async function fromTemplate(t: Awaited<ReturnType<typeof createTestApp>>, templateId: string, id: string) {
  const template = (await t.app.templates()).find((x) => x.id === templateId)!;
  return t.app.workspace.save(id, template.name, structuredClone(template.definition));
}

/** What a model is shown of a definition, as a mutable copy a test can edit like a model would. */
const modelView = (definition: unknown, secrets: string[] = []) => structuredClone(logValue(maskSecretPairs(definition), 0, secrets)) as any;

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
      def.nodes[1]!.data.values['prompts'] = [{ role: 'system', content: 'Use key project-secret-value-77 carefully. Answer in Portuguese.' }];
      def.nodes[1]!.data.values['headers'] = [{ key: 'X-Api-Key', value: 'header-secret-1234' }, { key: 'Accept', value: 'application/json' }];
      await t.app.workspace.save('qa', draft.name, def, draft.revision);
      const answer = await t.app.assistant.ask({ flowId: 'qa', message: 'Why isn’t this workflow working?' });
      expect(answer.text).toBe('Upload documents to the handbook collection first.');
      expect(answer.model).toBe('local-chat');
      const sent = bodies.join('\n');
      expect(sent).toContain('Create the “handbook” collection');
      expect(sent).toContain('slack');
      // The model sees the workflow's real prompts (so it can reason about them) but no secret values.
      expect(sent).toContain('Answer in Portuguese.');
      expect(sent).toContain('application/json');
      for (const secret of ['sk-connection-key-0001', 'xoxb-credential-secret-9', 'project-secret-value-77', 'header-secret-1234']) expect(sent).not.toContain(secret);
    } finally {
      await t.close();
    }
  });

  it('keeps real values wherever a model proposal repeats a masked placeholder', () => {
    const original = { nodes: [{ id: 'a', data: { values: { prompts: [{ role: 'system', content: 'Use key s3cr3t-value' }], headers: [{ key: 'Authorization', value: 'Bearer real' }] } } }, { id: 'b', data: { values: { text: 'x'.repeat(9000) } } }], edges: [] };
    const proposed = { nodes: [{ id: 'b', data: { values: { text: `${'x'.repeat(8000)}…(+1000 chars)` } } }, { id: 'a', data: { values: { prompts: [{ role: 'system', content: 'Use key [SECRET]' }], headers: [{ key: 'Authorization', value: '[REDACTED]' }], extra: 'new' } } }, { id: 'c', data: { values: { note: '[REDACTED]' } } }], edges: [] };
    expect(restoreMasked(proposed, original)).toEqual({ nodes: [original.nodes[1], { id: 'a', data: { values: { ...original.nodes[0]!.data.values, extra: 'new' } } }, { id: 'c', data: { values: { note: '[REDACTED]' } } }], edges: [] });
    expect(maskSecretPairs([{ key: 'X-Api-Key', value: 'k' }, { name: 'Accept', value: 'json' }])).toEqual([{ key: 'X-Api-Key', value: '[REDACTED]' }, { name: 'Accept', value: 'json' }]);
  });

  it('matches list items by id or key, so inserting, removing or reordering items never moves a secret', () => {
    const headers = [{ key: 'Accept', value: 'json' }, { key: 'X-Api-Key', value: 'sk-live-0123456789abcdef' }];
    const original = { nodes: [{ id: 'call', data: { nodeId: 'apiNode', values: { headers } } }], edges: [] };
    const headersOf = (d: unknown) => (d as any).nodes[0].data.values.headers;
    const inserted = modelView(original);
    expect(headersOf(inserted)[1].value).toBe('[REDACTED]');
    headersOf(inserted).unshift({ key: 'X-Trace', value: 'on' });
    expect(headersOf(restoreMasked(inserted, original))).toEqual([{ key: 'X-Trace', value: 'on' }, ...headers]);
    const removed = modelView(original);
    headersOf(removed).shift();
    expect(headersOf(restoreMasked(removed, original))).toEqual([headers[1]]);
    const reordered = modelView(original);
    headersOf(reordered).reverse();
    expect(headersOf(restoreMasked(reordered, original))).toEqual([headers[1], headers[0]]);
    // Items without an id or key match by position only while the list keeps its shape, and only where the visible text still fits.
    const messages = [{ role: 'system', content: 'Use key s3cr3t-value-1 carefully' }, { role: 'user', content: 'Hi' }];
    const prompts = { nodes: [{ id: 'llm', data: { nodeId: 'LLMNode', values: { messages } } }], edges: [] };
    const swapped = modelView(prompts, ['s3cr3t-value-1']);
    swapped.nodes[0].data.values.messages.reverse();
    expect(restoreMasked(swapped, prompts)).toMatchObject({ nodes: [{ data: { values: { messages: [{ role: 'user', content: 'Hi' }, { role: 'system', content: 'Use key [SECRET] carefully' }] } } }] });
    const edited = modelView(prompts, ['s3cr3t-value-1']);
    edited.nodes[0].data.values.messages[1].content = 'Hello';
    expect(restoreMasked(edited, prompts)).toMatchObject({ nodes: [{ data: { values: { messages: [messages[0], { role: 'user', content: 'Hello' }] } } }] });
  });

  it('restores long lists and embedding vectors the model only saw shortened', () => {
    const items = Array.from({ length: 150 }, (_, i) => `item ${i}`);
    const vectors = [Array.from({ length: 20 }, (_, i) => i / 20), Array.from({ length: 20 }, (_, i) => 1 - i / 20)];
    const original = { nodes: [{ id: 'list', data: { nodeId: 'codeNode', values: { items, vectors } } }], edges: [] };
    const proposal = modelView(original);
    expect(proposal.nodes[0].data.values.items).toHaveLength(101);
    expect(proposal.nodes[0].data.values.items[100]).toBe('…(+50 items)');
    expect(proposal.nodes[0].data.values.vectors).toEqual(['[vector 20]', '[vector 20]']);
    proposal.nodes[0].data.values.items[0] = 'first';
    expect(restoreMasked(proposal, original)).toEqual({ nodes: [{ id: 'list', data: { nodeId: 'codeNode', values: { items: ['first', ...items.slice(1)], vectors } } }], edges: [] });
    // A model that drops the marker cannot have meant to delete items it never saw.
    const dropped = modelView(original);
    dropped.nodes[0].data.values.items.pop();
    expect(restoreMasked(dropped, original)).toEqual(original);
  });

  it('applies a model proposal that edits masked and shortened lists without losing the real values', async () => {
    const fetch = fakeFetch((url, init) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'local-chat' }] });
      // The fake model edits exactly what it was shown: a new header first, and a new first item in the long list.
      const { definition } = JSON.parse(JSON.parse(String(init.body)).messages[1].content).flow;
      definition.nodes[1].data.values.headers.unshift({ key: 'X-Trace', value: 'on' });
      definition.nodes[1].data.values.allowed.unshift('new');
      return Response.json({ model: 'local-chat', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ explanation: 'Adds a trace header.', definition }) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
    });
    const t = await createTestApp({ fetch });
    try {
      t.app.connections.upsert({ id: 'local', name: 'Local', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' });
      t.app.connections.setDefaults({ chat: 'local' });
      const draft = await fromTemplate(t, 'first-workflow', 'first');
      const def = draft.definition as any;
      const headers = [{ key: 'Accept', value: 'application/json' }, { key: 'X-Api-Key', value: 'sk-live-0123456789abcdef' }];
      const allowed = Array.from({ length: 150 }, (_, i) => `domain-${i}.example`);
      Object.assign(def.nodes[1].data.values, { headers, allowed });
      const saved = await t.app.workspace.save('first', draft.name, def, draft.revision);
      const answer = await t.app.assistant.ask({ flowId: 'first', message: 'Add a trace header', propose: true });
      const proposal = answer.proposal!;
      expect(proposal.validation.ok).toBe(true);
      const applied = await t.app.assistant.apply('first', { definition: proposal.definition, expectedRevision: saved.revision, summary: proposal.summary });
      expect((applied.definition as any).nodes[1].data.values).toMatchObject({ headers: [{ key: 'X-Trace', value: 'on' }, ...headers], allowed: ['new', ...allowed] });
    } finally {
      await t.close();
    }
  });

  it('refuses to apply a proposal that still holds a placeholder, so a real value is never overwritten', async () => {
    const t = await createTestApp();
    try {
      const draft = await fromTemplate(t, 'first-workflow', 'first');
      const def = draft.definition as any;
      def.nodes[1].data.values.apiKey = 'real-api-key-value';
      def.nodes[1].data.values.outputMapping.source = 'Emails are shown as [REDACTED]';
      const saved = await t.app.workspace.save('first', draft.name, def, draft.revision);
      // The model renamed the response step, so its masked key has nothing to be restored from.
      const proposal = modelView(saved.definition);
      proposal.nodes[1].id = 'reply';
      proposal.edges[0].target = 'reply';
      const restored = restoreMasked(proposal, saved.definition);
      await expect(t.app.assistant.apply('first', { definition: restored, expectedRevision: saved.revision })).rejects.toMatchObject({
        code: 'BAD_PAYLOAD', message: expect.stringContaining('nodes[1].data.values.apiKey'),
      });
      expect(t.app.workspace.get('first')!.revision).toBe(saved.revision);
      // Text that already contains placeholder-like words is not mistaken for one, and can still be edited.
      const kept = modelView(saved.definition);
      kept.nodes[1].data.values.nodeName = 'Reply';
      kept.nodes[1].data.values.outputMapping.source = 'Emails are always shown as [REDACTED]';
      const applied = await t.app.assistant.apply('first', { definition: restoreMasked(kept, saved.definition), expectedRevision: saved.revision });
      expect((applied.definition as any).nodes[1].data.values).toMatchObject({ nodeName: 'Reply', apiKey: 'real-api-key-value', outputMapping: { source: 'Emails are always shown as [REDACTED]' } });
      // A proposal sent back without restoring is refused too: its placeholder would replace the real key.
      await expect(t.app.assistant.apply('first', { definition: modelView(applied.definition), expectedRevision: applied.revision })).rejects.toMatchObject({ code: 'BAD_PAYLOAD' });
    } finally {
      await t.close();
    }
  });

  it('requires expectedRevision to apply a proposal over REST', async () => {
    const t = await createTestApp();
    try {
      const draft = await fromTemplate(t, 'first-workflow', 'first');
      await withHttp(t.app, async (base) => {
        const req = jsonRequest(base);
        const missing = await req('/api/flows/first/assistant/apply', 'POST', { definition: draft.definition });
        expect(missing.status).toBe(400);
        expect((await req('/api/flows/first/assistant/apply', 'POST', { expectedRevision: draft.revision })).status).toBe(400);
        expect((await req('/api/flows/first/assistant/apply', 'POST', { definition: draft.definition, expectedRevision: '1' })).status).toBe(400);
        expect(t.app.workspace.get('first')!.revision).toBe(draft.revision);
        expect((await req('/api/flows/first/assistant/apply', 'POST', { definition: draft.definition, expectedRevision: draft.revision + 1 })).status).toBe(409);
        const applied = await req('/api/flows/first/assistant/apply', 'POST', { definition: draft.definition, expectedRevision: draft.revision, summary: 'No-op' });
        expect(applied.status).toBe(200);
        expect(applied.data.revision).toBe(draft.revision + 1);
      });
    } finally {
      await t.close();
    }
  });

  it('reverts a copilot change only while the workflow is still at the revision that change produced', async () => {
    const t = await createTestApp();
    try {
      await fromTemplate(t, 'getting-started', 'chat');
      const proposal = (await t.app.assistant.ask({ flowId: 'chat', action: 'add-retrieval' })).proposal!;
      const applied = await t.app.assistant.apply('chat', { definition: proposal.definition, expectedRevision: proposal.expectedRevision });
      const [change] = t.app.assistant.history('chat');
      const manual = await t.app.workspace.save('chat', applied.name, { ...(applied.definition as object), meta: { note: 'edited by hand' } }, applied.revision);
      await expect(t.app.assistant.revert('chat', change!.id, manual.revision)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('changed after this copilot change') });
      expect(t.app.workspace.get('chat')!.definition).toEqual(manual.definition);
      await withHttp(t.app, async (base) => {
        const res = await jsonRequest(base)(`/api/flows/chat/assistant/history/${change!.id}/revert`, 'POST', { expectedRevision: manual.revision });
        expect(res.status).toBe(409);
        expect(res.data.errors[0].message).toContain('changed after this copilot change');
      });
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
      // Losing a deploy race to a newer version is not a failure of the live workflow.
      await expect(t.app.deployFlow('first', { expectedVersion: 'v_stale' })).rejects.toMatchObject({ code: 'CONFLICT' });
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
