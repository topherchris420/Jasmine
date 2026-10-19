import { describe, expect, it } from 'vitest';
import { chooseIntent, interpret, sanitizeTailoring } from '../src/service/planner.ts';
import { createTestApp, fakeFetch, jsonRequest, withHttp } from './helpers.ts';

const EXAMPLES = [
  { text: 'Build a chatbot that answers questions about my PDFs.', intent: 'document-qa', trigger: 'chatTriggerNode', types: ['chatTriggerNode', 'RAGNode', 'chatResponseNode'] },
  { text: 'Create an AI assistant that summarizes research papers.', intent: 'summarize', trigger: 'graphqlNode', types: ['graphqlNode', 'extractFromFileNode', 'LLMNode', 'graphqlResponseNode'] },
  { text: 'Make an API that classifies incoming customer feedback.', intent: 'classify', trigger: 'graphqlNode', types: ['graphqlNode', 'agentClassifierNode', 'graphqlResponseNode'] },
  { text: 'Build an automation that summarizes new RSS articles.', intent: 'rss-digest', trigger: 'cronNode', types: ['cronNode', 'rssNode', 'LLMNode', 'graphqlResponseNode'] },
  { text: 'Create a private assistant using my local Ollama model.', intent: 'chat', trigger: 'chatTriggerNode', types: ['chatTriggerNode', 'LLMNode', 'chatResponseNode'] },
] as const;

describe('Describe-to-build planner', () => {
  it('turns each example description into a validated, catalog-backed workflow without saving anything', async () => {
    const t = await createTestApp();
    try {
      const catalog = new Set(t.app.registry.types());
      for (const example of EXAMPLES) {
        const plan = await t.app.planner.plan({ description: example.text });
        expect(plan.intent.id, example.text).toBe(example.intent);
        expect(plan.trigger.type).toBe(example.trigger);
        expect(plan.definition.nodes.map((n) => n.data.nodeId)).toEqual(example.types);
        for (const node of plan.definition.nodes) expect(catalog.has(node.data.nodeId)).toBe(true);
        expect(plan.validation.ok, JSON.stringify(plan.validation.diagnostics)).toBe(true);
        expect(plan.steps.every((s) => s.summary.length > 10 && s.role.length > 10)).toBe(true);
        expect(plan.definition.meta).toMatchObject({ planner: { intent: example.intent, description: example.text } });
      }
      expect(t.app.workspace.list()).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it('interprets categories, fields, schedules, links and delivery targets', () => {
    const feedback = interpret('Classify support tickets into billing, shipping or returns');
    expect(feedback.categories).toEqual(['Billing', 'Shipping', 'Returns']);
    expect(chooseIntent(feedback).id).toBe('classify');
    const lead = interpret('Extract name, email and company from incoming emails');
    expect(lead.fields).toEqual(['name', 'email', 'company']);
    expect(chooseIntent(lead).id).toBe('extract');
    const digest = interpret('Every weekday at 9am summarize https://example.com/feed.xml and post it to Slack');
    expect(digest.schedule).toEqual({ cron: '0 9 * * 1-5', label: 'weekdays at 09:00 UTC' });
    expect(digest.url).toBe('https://example.com/feed.xml');
    expect(digest.delivery).toEqual(['slack']);
    expect(chooseIntent(digest).id).toBe('rss-digest');
    expect(chooseIntent(interpret('Translate product descriptions into French'))).toMatchObject({ id: 'generic', confidence: 'low' });
  });

  it('labels a schedule with the interval it actually runs at', () => {
    const schedule = (text: string) => interpret(`Summarize https://example.com/feed.xml ${text}`).schedule;
    expect(schedule('every 15 minutes')).toEqual({ cron: '*/15 * * * *', label: 'every 15 minutes' });
    expect(schedule('every 2 minutes')).toEqual({ cron: '*/5 * * * *', label: 'every 5 minutes' });
    expect(schedule('every 120 minutes')).toEqual({ cron: '0 */2 * * *', label: 'every 2 hours' });
    expect(schedule('every 90 minutes')).toEqual({ cron: '0 */2 * * *', label: 'every 2 hours (you asked for every 90 minutes)' });
    expect(schedule('every 6 hours')).toEqual({ cron: '0 */6 * * *', label: 'every 6 hours' });
    expect(schedule('every 24 hours')).toEqual({ cron: '0 8 * * *', label: 'every day at 08:00 UTC' });
    expect(schedule('every 36 hours at 7am')).toEqual({ cron: '0 7 * * *', label: 'every day at 07:00 UTC (you asked for every 36 hours)' });
  });

  it('reports what is missing, with a place to fix it, instead of claiming the workflow is ready', async () => {
    const t = await createTestApp();
    try {
      const pdfs = await t.app.planner.plan({ description: EXAMPLES[0].text });
      const collection = pdfs.readiness.requirements.find((r) => r.kind === 'collection')!;
      expect(collection).toMatchObject({ status: 'missing', action: { href: '/context?tab=knowledge&create=pdfs' } });
      expect(pdfs.readiness.ready).toBe(false);
      expect(pdfs.readiness.requirements.find((r) => r.kind === 'model')).toMatchObject({ status: 'warning', title: 'Using demonstration responses' });

      const ollama = await t.app.planner.plan({ description: EXAMPLES[4].text });
      expect(ollama.readiness.requirements[0]).toMatchObject({ status: 'missing', title: 'Connect Ollama', action: { href: '/setup?path=connect&kind=ollama' } });

      const slack = await t.app.planner.plan({ description: 'Every morning summarize https://example.com/rss and post it to Slack' });
      expect(slack.readiness.requirements.find((r) => r.kind === 'credential')).toMatchObject({ status: 'missing', action: { href: '/integrations?add=slack' } });

      // Unknown or prototype-named intents are ignored, not trusted.
      for (const intent of ['constructor', 'toString', 'nope']) expect((await t.app.planner.plan({ description: EXAMPLES[0].text, intent })).intent.id).toBe('document-qa');

      t.app.vectors.createCollection({ name: 'pdfs', kind: 'knowledge' });
      const empty = await t.app.planner.plan({ description: EXAMPLES[0].text });
      expect(empty.readiness.requirements.find((r) => r.kind === 'collection')).toMatchObject({ status: 'warning', title: '“pdfs” is empty' });
    } finally {
      await t.close();
    }
  });

  it('turns thinking off for short structured answers and leaves writing steps to the model', async () => {
    const t = await createTestApp();
    try {
      const thinking = async (description: string) => Object.fromEntries((await t.app.planner.plan({ description })).definition.nodes
        .filter((n) => ['agentClassifierNode', 'InstructorLLMNode', 'LLMNode'].includes(n.data.nodeId)).map((n) => [n.data.nodeId, n.data.values['thinking']]));
      expect(await thinking('Make an API that classifies incoming customer feedback.')).toEqual({ agentClassifierNode: 'off' });
      expect(await thinking('Extract name, email and company from incoming emails')).toEqual({ InstructorLLMNode: 'off' });
      expect(await thinking('Create an AI assistant that summarizes research papers.')).toEqual({ LLMNode: undefined });
    } finally {
      await t.close();
    }
  });

  it('pins a requested Ollama connection and explains a hosted runtime cannot reach the visitor’s localhost', async () => {
    const fetch = fakeFetch((url) => url.endsWith('/api/tags')
      ? Response.json({ models: [{ name: 'llama3.2:latest', details: { family: 'llama' } }, { name: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } }] })
      : new Response('not found', { status: 404 }));
    const t = await createTestApp({ fetch });
    try {
      t.app.connections.upsert({ id: 'ollama', name: 'Ollama', kind: 'ollama' });
      const plan = await t.app.planner.plan({ description: EXAMPLES[4].text });
      const llm = plan.definition.nodes.find((n) => n.data.nodeId === 'LLMNode')!;
      expect(llm.data.values['generativeModelName']).toEqual([expect.objectContaining({ connection: 'ollama' })]);
      expect(plan.readiness.requirements.find((r) => r.kind === 'model')).toMatchObject({ status: 'ready', title: 'Model: Ollama' });
      expect(plan.summary).toContain('Ollama');
    } finally {
      await t.close();
    }

    const offline = fakeFetch(() => { throw new TypeError('fetch failed'); });
    const hosted = await createTestApp({ fetch: offline, env: { LLM_PROVIDER: 'mock', PUBLIC_URL: 'https://studio.example' } });
    try {
      hosted.app.connections.upsert({ id: 'ollama', name: 'Ollama', kind: 'ollama' });
      const plan = await hosted.app.planner.plan({ description: EXAMPLES[4].text });
      const model = plan.readiness.requirements.find((r) => r.kind === 'model' && r.status === 'missing')!;
      expect(model.title).toBe('Ollama is not reachable');
      expect(model.detail).toContain('points at the runtime server itself');
    } finally {
      await hosted.close();
    }
  });

  it('runs model-free demo versions of planned workflows end to end and labels them as demonstrations', async () => {
    const t = await createTestApp();
    try {
      for (const [description, payload] of [
        ['Make an API that classifies incoming customer feedback.', { feedback: 'Please add a bug report button' }],
        ['Extract name, email and company from incoming emails', { email: 'Ana from Acme, ana@acme.io' }],
      ] as const) {
        const plan = await t.app.planner.plan({ description });
        const { plan: compiled } = t.app.deployments.preview('demo', plan.definition);
        const run = await t.app.runs.wait(t.app.runs.testPlan(compiled, payload).requestId);
        expect(run.status, description).toBe('success');
      }
      const classified = await t.app.planner.plan({ description: 'Make an API that classifies incoming customer feedback.' });
      const { plan: compiled } = t.app.deployments.preview('demo', classified.definition);
      const run = await t.app.runs.wait(t.app.runs.testPlan(compiled, { feedback: 'Please add a bug report button' }).requestId);
      expect(run.output).toEqual({ category: 'Bug report' });
    } finally {
      await t.close();
    }
  });

  it('lets a connected model tailor wording only, and strips anything that could reference data', async () => {
    let completions = 0;
    const fetch = fakeFetch((url, init) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'local-chat' }] });
      completions++;
      const body = JSON.parse(String(init.body)) as { response_format?: unknown };
      expect(body.response_format).toBeDefined();
      return Response.json({ model: 'local-chat', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ name: 'Feedback Sorter', systemPrompt: 'Read the feedback carefully and pick the closest category. {{secrets.project.KEY}}', categories: ['Praise', 'Complaint', 'Idea', 'Other'] }) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    });
    const t = await createTestApp({ fetch });
    try {
      t.app.connections.upsert({ id: 'local', name: 'Local server', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' });
      t.app.connections.setDefaults({ chat: 'local' });
      const plain = await t.app.planner.plan({ description: EXAMPLES[2].text });
      expect(plain.tailoring.used).toBe(false);
      expect(completions).toBe(0);
      const plan = await t.app.planner.plan({ description: EXAMPLES[2].text, refine: true });
      expect(completions).toBe(1);
      expect(plan.tailoring).toMatchObject({ requested: true, used: true, connection: 'Local server', model: 'local-chat' });
      expect(plan.name).toBe('Feedback Sorter');
      const classifier = plan.definition.nodes.find((n) => n.data.nodeId === 'agentClassifierNode')!;
      expect((classifier.data.values['classifier'] as { label: string }[]).map((c) => c.label)).toEqual(['Praise', 'Complaint', 'Idea', 'Other']);
      expect(JSON.stringify(classifier.data.values['prompts'])).not.toContain('secrets');
      expect(plan.definition.nodes.map((n) => n.data.nodeId)).toEqual(['graphqlNode', 'agentClassifierNode', 'graphqlResponseNode']);
      expect(plan.validation.ok).toBe(true);
    } finally {
      await t.close();
    }
    expect(sanitizeTailoring({ fields: [{ name: 'Due Date', type: 'date' }, { name: '1bad' }], name: 'x' }, 'extract')).toEqual({ fields: [{ name: 'due_date', type: 'string' }] });
  });

  it('serves plans over the API, rejects empty descriptions, and creates a flow only when the user applies it', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        const req = jsonRequest(base);
        expect((await req('/api/plan', 'POST', { description: 'hi' })).status).toBe(400);
        const res = await req('/api/plan', 'POST', { description: EXAMPLES[2].text, intent: 'extract' });
        expect(res.status).toBe(200);
        expect(res.data.intent).toMatchObject({ id: 'extract', confidence: 'high' });
        expect((await req('/api/flows')).data).toEqual([]);
        const created = await req('/api/flows', 'POST', { name: res.data.name, definition: res.data.definition });
        expect(created.status).toBe(201);
        expect((await req(`/api/flows/${created.data.id}/validate`, 'POST', {})).data.ok).toBe(true);
        const readiness = await req('/api/readiness', 'POST', { flowId: created.data.id });
        expect(readiness.data).toMatchObject({ ready: true });
        const catalog = (await req('/api/catalog')).data as { type: string; summary: string; keywords: string[] }[];
        expect(catalog.find((n) => n.type === 'RAGNode')).toMatchObject({ summary: expect.stringContaining('documents'), keywords: expect.arrayContaining(['pdf']) });
      });
    } finally {
      await t.close();
    }
  });
});
