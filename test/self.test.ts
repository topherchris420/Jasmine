import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MockLLMProvider } from '../src/llm/providers.ts';
import { IDENTITY, identityText } from '../src/service/identity.ts';
import { analyzeRequirements, workspaceSnapshot } from '../src/service/readiness.ts';
import { createTestApp, jsonRequest, withHttp, type TestApp } from './helpers.ts';

const version = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

async function askJasmine(t: TestApp, id = 'ask') {
  const template = (await t.app.templates()).find((x) => x.id === 'ask-jasmine')!;
  return t.app.workspace.save(id, template.name, structuredClone(template.definition));
}

async function install(t: TestApp, ...ids: string[]) {
  for (const id of ids) {
    await t.app.packs.install(id);
    expect((await t.app.packs.wait(id)).status).toBe('installed');
  }
}

describe('Jasmine’s self-model', () => {
  it('says who she is at every detail level, and nothing about the workspace at the identity level', async () => {
    const t = await createTestApp();
    try {
      const who = await t.app.self.describe('identity');
      expect(who).toMatchObject({ detail: 'identity', identity: { name: 'Jasmine', role: 'Hardware Architect', question: 'Can we actually build this?' }, limits: [] });
      expect(who).not.toHaveProperty('abilities');
      expect(who).not.toHaveProperty('models');
      expect(who).not.toHaveProperty('runtime');
      expect(who.summary).toMatch(/^I am Jasmine, a local-first AI workflow platform made by Vers3Dynamics\. In the R\.A\.I\.N\. Lab I am the Hardware Architect/);
      expect(who.summary).toContain('It is not consciousness, feelings or an inner life');

      const able = await t.app.self.describe('abilities');
      const visible = t.app.registry.catalog().filter((n) => !n.hidden);
      expect(able.abilities).toMatchObject({ steps: visible.length, applications: expect.arrayContaining(['Chat assistant']) });
      expect(able.abilities!.templates).toBe((await t.app.templates()).length);
      expect(able.models).toMatchObject({ demoOnly: true, probed: false, connections: [expect.objectContaining({ kind: 'mock', local: null })] });
      expect(able.models!.connections[0]).not.toHaveProperty('reachable');
      expect(able.knowledge!.packs.map((p) => p.status)).toEqual(['available', 'available', 'available', 'available']);
      expect(able).not.toHaveProperty('runtime');
      expect(able).not.toHaveProperty('experience');
      expect(able.knowledge).not.toHaveProperty('collections');
      expect(able.summary).toContain(`Here I can run ${visible.length} kinds of steps`);
      expect(able.summary).toContain('No AI model is connected to me right now');

      const all = await t.app.self.describe('state', { probe: true });
      expect(all.runtime).toMatchObject({ version, persistent: false, hosted: false, workflows: 0, load: { active: 0, queued: 0 } });
      expect(all.models!.probed).toBe(true);
      expect(all.models!.connections[0]!.reachable).toBe(true);
      expect(all.summary).toContain(`I am version ${version} on Node.js`);
    } finally {
      await t.close();
    }
  });

  it('measures her own track record and names what stops her right now', async () => {
    const t = await createTestApp();
    try {
      const before = await t.app.self.describe('state');
      expect(before.limits).toEqual(expect.arrayContaining([
        expect.stringMatching(/^No AI model is connected/),
        expect.stringMatching(/^None of my knowledge packs are installed/),
        expect.stringMatching(/^Document search uses built-in keyword matching/),
      ]));
      expect(before.summary).toContain('I have not run any workflows in the last 7 days.');

      // One run fails (the collection is missing), one succeeds.
      await askJasmine(t);
      const { plan } = t.app.deployments.preview('ask', t.app.workspace.get('ask')!.definition);
      expect((await t.app.runs.wait(t.app.runs.testPlan(plan, { chatMessage: 'Who are you?' }).requestId)).status).toBe('failed');
      await install(t, 'rain-lab');
      expect((await t.app.runs.wait(t.app.runs.testPlan(plan, { chatMessage: 'Who are you?' }).requestId)).status).toBe('success');

      const after = await t.app.self.describe('state');
      expect(after.experience).toMatchObject({ runs: 2, succeeded: 1, failed: 1, successRate: 0.5, topErrors: [expect.objectContaining({ code: 'NOT_FOUND', runs: 1 })] });
      expect(after.summary).toMatch(/In the last 7 days I ran 2 workflows: 1 succeeded \(50%\)/);
      expect(after.knowledge!.collections).toEqual([expect.objectContaining({ name: 'jasmine-knowledge', documents: 33 })]);
      expect(after.limits.some((l) => l.startsWith('None of my knowledge packs'))).toBe(false);
      expect(after.limits).toContainEqual(expect.stringMatching(/^Not installed yet: Jasmine’s own documentation, openai\/math catalogue and Vers3Dynamics projects\./));
      expect(after.summary).toContain('My installed knowledge: R.A.I.N. Lab (33 documents).');
    } finally {
      await t.close();
    }
  });

  it('feeds the self-model and her knowledge into an Ask Jasmine reply, with sources', async () => {
    const llm = new MockLLMProvider();
    const t = await createTestApp({ llm });
    try {
      await install(t, 'rain-lab', 'jasmine-docs');
      await askJasmine(t);
      const { plan } = t.app.deployments.preview('ask', t.app.workspace.get('ask')!.definition);
      const run = await t.app.runs.wait(t.app.runs.testPlan(plan, { chatMessage: 'Who is Elena?', chatHistory: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello!' }] }).requestId);
      expect(run.status).toBe('success');
      const request = llm.requests.at(-1)!;
      const system = request.messages[0]!.content as string;
      expect(system).toMatch(/^You are Jasmine\./);
      expect(system).toContain('I am Jasmine, a local-first AI workflow platform');
      expect(system).toContain('My installed knowledge: Jasmine’s own documentation');
      expect(system).toContain('never call a manuscript-only result proven');
      expect(request.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
      // Built-in keyword embeddings rank loosely, so the test asks only that Elena's own file reached the model and the reply.
      expect(request.messages.at(-1)!.content).toMatch(/\[\d\] Elena — Quantum Information Theorist/);
      const output = run.output as { content: string; references: { title: string; url: string; pack: string }[] };
      expect(output.content).toMatch(/^echo:/);
      expect(output.references).toContainEqual(expect.objectContaining({ pack: 'rain-lab', title: expect.stringMatching(/^Elena — /), url: expect.stringContaining('ELENA_SOUL.md') }));
    } finally {
      await t.close();
    }
  });

  it('validates the About Jasmine step and fails clearly where there is no self-model', async () => {
    const t = await createTestApp();
    try {
      const handler = t.app.registry.get('selfNode')!;
      expect(handler.spec).toMatchObject({ label: 'About Jasmine', category: 'ai' });
      expect(handler.validate!({ id: 's', type: 'selfNode', trigger: false, values: { detail: 'state' } })).toEqual([]);
      expect(handler.validate!({ id: 's', type: 'selfNode', trigger: false, values: { detail: 'everything' } })).toEqual([expect.objectContaining({ code: 'FIELD_INVALID', nodeId: 's' })]);
      const ctx = { values: { detail: 'identity' }, services: {} } as unknown as Parameters<typeof handler.run>[0];
      await expect(handler.run(ctx)).rejects.toThrow('This runtime cannot describe itself');
      const out = await handler.run({ ...ctx, services: t.app.services });
      expect(out.output).toMatchObject({ detail: 'identity', identity: { name: 'Jasmine' } });
    } finally {
      await t.close();
    }
  });

  it('points Ask Jasmine at the knowledge packs, and warns before sharing workspace state in a public widget', async () => {
    const t = await createTestApp();
    try {
      const flow = await askJasmine(t);
      const check = async (definition: unknown) => analyzeRequirements(definition, await workspaceSnapshot(t.app), t.app.registry.catalog()).requirements;
      expect(await check(flow.definition)).toContainEqual(expect.objectContaining({ status: 'missing', title: 'Install Jasmine’s knowledge packs', action: { label: 'Install knowledge packs', href: '/jasmine#knowledge' } }));
      await install(t, 'rain-lab');
      const ready = await check(flow.definition);
      expect(ready).toContainEqual(expect.objectContaining({ status: 'ready', title: 'Knowledge: jasmine-knowledge' }));
      expect(ready.some((r) => r.title.includes('would share workspace details'))).toBe(false);
      const exposed = structuredClone(flow.definition) as { nodes: { id: string; data: { values: Record<string, unknown> } }[] };
      exposed.nodes.find((n) => n.id === 'self_1')!.data.values['detail'] = 'state';
      expect(await check(exposed)).toContainEqual(expect.objectContaining({ status: 'warning', kind: 'exposure', title: '“About Jasmine” would share workspace details', nodeIds: ['self_1'] }));
    } finally {
      await t.close();
    }
  });

  it('answers “About Jasmine” in the copilot from her own measurements', async () => {
    const t = await createTestApp();
    try {
      await askJasmine(t);
      const about = await t.app.assistant.ask({ flowId: 'ask', action: 'self' });
      expect(about.model).toBeNull();
      expect(about.text).toMatch(/^I am Jasmine/);
      expect(about.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'missing', title: 'Connect an AI model' }),
        expect.objectContaining({ status: 'info', title: 'Install my knowledge packs (4 of 4 not installed)', action: { label: 'Open About Jasmine', href: '/jasmine#knowledge' } }),
      ]));
      await install(t, 'rain-lab');
      const later = await t.app.assistant.ask({ flowId: 'ask', action: 'self' });
      expect(later.findings).toContainEqual(expect.objectContaining({ status: 'ready', title: 'Knowledge: R.A.I.N. Lab', detail: '33 documents, searchable in workflows.' }));
    } finally {
      await t.close();
    }
  });

  it('describes herself over REST and MCP, to admins only', async () => {
    const t = await createTestApp();
    try {
      const admin = t.app.apiKeys.create('admin', 'admin').token;
      const execute = t.app.apiKeys.create('execute', 'execute').token;
      await withHttp(t.app, async (base) => {
        const asAdmin = jsonRequest(base, { authorization: `Bearer ${admin}` });
        const asApp = jsonRequest(base, { authorization: `Bearer ${execute}` });
        expect((await asAdmin('/api/self?detail=identity')).data).toMatchObject({ detail: 'identity', identity: { name: 'Jasmine', origin: { soul: { sha256: IDENTITY.origin.soul.sha256 } } } });
        expect((await asAdmin('/api/self')).data).toMatchObject({ detail: 'state', runtime: { version } });
        expect((await asAdmin('/api/self?detail=everything')).status).toBe(400);
        expect((await asApp('/api/self')).status).toBe(403);
        const msg = (method: string, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
        const adminTools = (await asAdmin('/mcp', 'POST', msg('tools/list'))).data.result.tools as { name: string }[];
        expect(adminTools.some((x) => x.name === 'jasmine_self')).toBe(true);
        expect(((await asApp('/mcp', 'POST', msg('tools/list'))).data.result.tools as { name: string }[]).some((x) => x.name === 'jasmine_self')).toBe(false);
        const called = await asAdmin('/mcp', 'POST', msg('tools/call', { name: 'jasmine_self', arguments: { detail: 'abilities' } }));
        expect(JSON.parse(called.data.result.content[0].text)).toMatchObject({ detail: 'abilities', models: { demoOnly: true } });
      });
    } finally {
      await t.close();
    }
  });

  it('keeps her identity in one record that cites the soul file it came from', () => {
    expect(IDENTITY.origin.soul).toMatchObject({ repository: 'topherchris420/james_library', path: 'JASMINE_SOUL.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const text = identityText();
    for (const principle of IDENTITY.principles) expect(text).toContain(principle);
    expect(text).toContain('My colleagues in the lab: James, the Lead Scientist');
    expect(text.endsWith(IDENTITY.awareness)).toBe(true);
  });
});
