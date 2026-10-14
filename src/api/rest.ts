import { compareModels } from '../service/model-evals.ts';
import type { Jasmine } from '../app.ts';
import { EngineError } from '../errors.ts';
import { parseFlowFile } from '../flow/import.ts';
import { chat as chatCall, embed } from '../llm/router.ts';
import type { LLMMessage } from '../llm/types.ts';
import { toOtelSpans } from '../runtime/trace.ts';
import { slug } from '../service/connections.ts';
import { MAX_UPLOAD_BYTES } from '../service/files.ts';
import { parseFilter } from '../vector/filters.ts';
import { HANDLED, openStream, Reply, type Router } from './http.ts';

const FLOW_ID = /^[A-Za-z0-9_-]{1,100}$/;

function requireFlowId(id: string): string {
  if (!FLOW_ID.test(id)) throw new EngineError('BAD_PAYLOAD', 'Invalid flow id');
  return id;
}

/** Inlines kit file references (`@prompts/x.md`, `@scripts/x.ts`) from uploaded kit files. */
function inlineRefs(value: unknown, refs: Record<string, string>): unknown {
  if (typeof value === 'string' && value.startsWith('@')) {
    const hit = refs[value] ?? refs[value.replace(/^@/, '')];
    return hit === undefined ? value : hit.replace(/^\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*/, (m) => (value.startsWith('@scripts/') ? m : ''));
  }
  if (Array.isArray(value)) return value.map((v) => inlineRefs(v, refs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inlineRefs(v, refs)]));
  return value;
}

function uniqueFlowId(app: Jasmine, name: string): string {
  const base = slug(name).replace(/^conn-/, 'flow-') || 'flow';
  let id = base;
  for (let i = 2; app.workspace.get(id); i++) id = `${base}-${i}`;
  return id;
}

const num = (v: string | null, fallback: number) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);

export function registerRest(router: Router, app: Jasmine): void {
  /* ---------- meta ---------- */

  router.get('/api/status', 'public', () => ({
    name: 'Jasmine', project: app.project.info(), authRequired: app.apiKeys.adminEnabled, load: app.runs.load,
  }));

  router.get('/api/overview', 'admin', () => {
    const flows = app.workspace.list();
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return {
      project: app.project.info(),
      flows: flows.length,
      deployed: app.deployments.activeFlows().length,
      collections: app.vectors.listCollections().length,
      connections: app.connections.list().length,
      defaults: app.connections.defaults(),
      week: app.runStore.report({ from: since }).totals,
      recent: app.runStore.list({ limit: 8 }).runs,
    };
  });

  router.get('/api/catalog', 'admin', () => app.registry.catalog().map((n) => ({ ...n, defaults: n.defaults() })));
  router.get('/api/templates', 'admin', () => app.templates());

  /* ---------- flows ---------- */

  router.get('/api/flows', 'admin', () => app.workspace.list().map((f) => app.flowSummary(f)));

  router.post('/api/flows', 'admin', async (req) => {
    const body = await req.json<{ name?: string; id?: string; definition?: unknown; templateId?: string }>();
    let definition = body.definition;
    let name = body.name?.trim();
    if (body.templateId) {
      const template = (await app.templates()).find((t) => t.id === body.templateId);
      if (!template) throw new EngineError('NOT_FOUND', 'Template not found');
      definition = structuredClone(template.definition);
      name ||= template.name;
    }
    name ||= 'Untitled flow';
    const id = body.id ? requireFlowId(body.id) : uniqueFlowId(app, name);
    if (app.workspace.get(id)) throw new EngineError('CONFLICT', `A flow with id ${id} already exists`);
    const flow = await app.workspace.save(id, name, definition ?? { nodes: [], edges: [] }, 0);
    return new Reply(201, app.flowSummary(flow));
  });

  router.post('/api/flows/import', 'admin', async (req) => {
    const body = await req.json<{ text?: string; name?: string; id?: string; refs?: Record<string, string> }>();
    if (typeof body.text !== 'string' || !body.text.trim()) throw new EngineError('BAD_PAYLOAD', 'Paste or upload a flow file');
    const parsed = parseFlowFile(body.text);
    const refs = body.refs && typeof body.refs === 'object' ? body.refs : {};
    const definition = { ...(parsed.meta ? { meta: parsed.meta } : {}), nodes: inlineRefs(parsed.nodes, refs), edges: parsed.edges };
    const name = body.name?.trim() || parsed.meta?.name || 'Imported flow';
    const id = body.id ? requireFlowId(body.id) : uniqueFlowId(app, name);
    const flow = await app.workspace.save(id, name, definition, app.workspace.get(id)?.revision ?? 0);
    return new Reply(201, { flow: app.flowSummary(flow), validation: app.deployments.validate(id, definition) });
  });

  router.get('/api/flows/:id', 'admin', (req) => {
    const flow = app.workspace.get(req.params['id']!);
    if (!flow) throw new EngineError('NOT_FOUND', 'Flow not found');
    return { ...flow, summary: app.flowSummary(flow) };
  });

  router.put('/api/flows/:id', 'admin', async (req) => {
    const id = requireFlowId(req.params['id']!);
    const body = await req.json<{ name?: unknown; definition?: unknown; expectedRevision?: unknown }>();
    if (typeof body.name !== 'string' || (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0))) {
      throw new EngineError('BAD_PAYLOAD', 'Invalid draft payload');
    }
    const flow = await app.workspace.save(id, body.name, body.definition, body.expectedRevision as number | undefined);
    return { ...flow, summary: app.flowSummary(flow) };
  });

  router.delete('/api/flows/:id', 'admin', async (req) => ({ deleted: await app.deleteFlow(requireFlowId(req.params['id']!)) }));

  router.post('/api/flows/:id/validate', 'admin', async (req) => {
    const id = requireFlowId(req.params['id']!);
    const body = await req.json<{ definition?: unknown }>();
    const definition = body.definition ?? app.workspace.get(id)?.definition;
    if (definition === undefined) throw new EngineError('NOT_FOUND', 'Flow not found');
    return app.deployments.validate(id, definition);
  });

  router.post('/api/flows/:id/deploy', 'admin', async (req) => {
    const body = await req.json<{ expectedVersion?: string | null }>();
    return app.deployFlow(requireFlowId(req.params['id']!), body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {});
  });

  router.post('/api/flows/:id/undeploy', 'admin', (req) => ({ undeployed: app.deployments.undeploy(req.params['id']!) }));

  router.get('/api/flows/:id/versions', 'admin', (req) => {
    const id = req.params['id']!;
    return { versions: app.deployments.listVersions(id).sort((a, b) => b.deployedAt.localeCompare(a.deployedAt)), history: app.deployments.deployHistory(id), active: app.deployments.getActive(id)?.version ?? null };
  });

  router.get('/api/flows/:id/versions/:version', 'admin', (req) => {
    const v = app.deployments.getVersion(req.params['id']!, req.params['version']!);
    if (!v) throw new EngineError('NOT_FOUND', 'Version not found');
    return { version: v.version, deployedAt: v.deployedAt, definition: v.plan.definition, diagnostics: v.diagnostics };
  });

  router.post('/api/flows/:id/rollback', 'admin', async (req) => {
    const body = await req.json<{ toVersion?: string }>();
    return app.deployments.rollback(req.params['id']!, body.toVersion ? { toVersion: body.toVersion } : {});
  });

  router.post('/api/flows/:id/test', 'admin', async (req) => {
    const id = requireFlowId(req.params['id']!);
    const body = await req.json<{ payload?: unknown; definition?: unknown }>();
    const definition = body.definition ?? app.workspace.get(id)?.definition;
    if (definition === undefined) throw new EngineError('NOT_FOUND', 'Flow not found');
    const { plan, diagnostics } = app.deployments.preview(id, definition);
    return { ...app.runs.testPlan(plan, body.payload ?? {}), diagnostics };
  });

  router.get('/api/flows/:id/sessions', 'admin', (req) => app.chat.sessions(req.params['id']!));
  router.get('/api/flows/:id/sessions/:session', 'admin', (req) => app.chat.history(req.params['id']!, req.params['session']!, 200));
  router.delete('/api/flows/:id/sessions/:session', 'admin', (req) => ({ deleted: app.chat.clear(req.params['id']!, req.params['session']!) }));

  /* ---------- runs, logs, reports ---------- */

  router.get('/api/runs', 'admin', (req) => app.runStore.list({
    ...(req.query.get('flowId') ? { flowId: req.query.get('flowId')! } : {}),
    ...(req.query.get('status') ? { status: req.query.get('status')! } : {}),
    ...(req.query.get('source') ? { source: req.query.get('source')! } : {}),
    ...(req.query.get('from') ? { from: req.query.get('from')! } : {}),
    ...(req.query.get('to') ? { to: req.query.get('to')! } : {}),
    ...(req.query.get('search') ? { search: req.query.get('search')! } : {}),
    ...(req.query.get('before') ? { before: req.query.get('before')! } : {}),
    limit: num(req.query.get('limit'), 50),
  }));

  router.get('/api/runs/:id', 'admin', (req) => {
    const run = app.runStore.get(req.params['id']!);
    if (!run) throw new EngineError('NOT_FOUND', 'Run not found');
    return {...run,feedback:app.feedback.list(run.id)};
  });

  router.get('/api/runs/:id/otel', 'admin', (req) => toOtelSpans(app.runs.trace(req.params['id']!)));

  router.get('/api/runs/:id/events', 'execute', (req) => {
    const id = req.params['id']!;
    if (!app.runs.events.isLive(id)) {
      const status = app.runs.checkStatus(id);
      const stream = openStream(req.raw, req.res);
      stream.send('done', status);
      stream.close();
      return HANDLED;
    }
    const stream = openStream(req.raw, req.res);
    const unsubscribe = app.runs.events.subscribe(id, (e) => {
      if (e.type === 'trace') stream.send('trace', e.event);
      else if (e.type === 'node') stream.send(e.event.type, { nodeId: e.nodeId, data: e.event.data });
      else {
        stream.send('done', e.response);
        stream.close();
      }
    });
    stream.onClose(unsubscribe);
    return HANDLED;
  });

  router.post('/api/runs/:id/cancel', 'execute', (req) => ({ cancelled: app.runs.cancel(req.params['id']!) }));
  router.post('/api/runs/:id/retry', 'admin', (req) => app.runs.retryWorkflow(req.params['id']!));

  router.get('/api/reports', 'admin', (req) => {
    const days = num(req.query.get('days'), 7);
    const from = req.query.get('from') ?? new Date(Date.now() - days * 86_400_000).toISOString();
    return app.runStore.report({
      from, ...(req.query.get('to') ? { to: req.query.get('to')! } : {}), ...(req.query.get('flowId') ? { flowId: req.query.get('flowId')! } : {}),
      bucket: req.query.get('bucket') === 'hour' || days <= 2 ? 'hour' : 'day',
    });
  });

  router.get('/api/schedules', 'admin', () => app.scheduler.list());
  router.post('/api/schedules/:flowId/run', 'admin', async (req) => ({ requestId: await app.scheduler.runNow(req.params['flowId']!) ?? null }));

  /* ---------- local monitoring alerts ---------- */
  router.get('/api/alerts', 'admin', (req) => ({ events: app.alerts.list(req.query.get('unread') === 'true', num(req.query.get('limit'), 100)), rules: app.alerts.rules() }));
  router.post('/api/alerts/rules', 'admin', async (req) => new Reply(201, app.alerts.upsert(await req.json())));
  router.put('/api/alerts/rules/:id', 'admin', async (req) => app.alerts.upsert({ ...await req.json(), id: req.params['id']! }));
  router.delete('/api/alerts/rules/:id', 'admin', (req) => ({ deleted: app.alerts.remove(req.params['id']!) }));
  router.post('/api/alerts/:id/acknowledge', 'admin', (req) => ({ acknowledged: app.alerts.acknowledge(req.params['id']!) }));

  router.get('/api/feedback','admin',(req)=>app.feedback.list(req.query.get('requestId')??undefined));
  router.post('/api/feedback','execute',async(req)=>app.feedback.submit(await req.json()));
  router.get('/api/flows/:id/cache','admin',(req)=>app.cache.policy(req.params['id']!));
  router.put('/api/flows/:id/cache','admin',async(req)=>{const b=await req.json<{enabled:boolean;ttlSeconds:number}>();if(typeof b.enabled!=='boolean'||!Number.isInteger(b.ttlSeconds)||b.ttlSeconds<1||b.ttlSeconds>86400)throw new EngineError('BAD_PAYLOAD','Cache TTL must be 1–86400 seconds');return app.cache.configure(req.params['id']!,b);});
  router.delete('/api/flows/:id/cache','admin',(req)=>({cleared:app.cache.clear(req.params['id']!)}));

  router.post('/api/flows/:id/assistant','admin',async req=>app.assistant.ask({...(await req.json<{message:string;nodeId?:string;propose?:boolean}>()),flowId:req.params['id']!}));
  router.post('/api/flows/:id/assistant/apply','admin',async req=>app.assistant.apply(req.params['id']!,await req.json() as never));
  router.get('/api/mailhooks','admin',()=>app.mailhook.addresses());

  router.post('/api/backups','admin',async req=>app.backups.export((await req.json<{passphrase:string}>()).passphrase));
  router.post('/api/backups/restore','admin',async req=>{const b=await req.json<{backup:unknown;passphrase:string}>(200_100_000);return app.backups.restore(b.backup,b.passphrase);});

  router.post('/api/models/compare','admin',async req=>compareModels(app,await req.json()));

  router.get('/api/oauth/providers','admin',()=>app.oauth.configurations());
  router.put('/api/oauth/providers/:provider','admin',async req=>app.oauth.configure(req.params['provider']!,await req.json() as never));
  router.post('/api/oauth/connect/:integration','admin',async req=>{const body=await req.json<{name:string;readOnly?:boolean}>();return app.oauth.begin(req.params['integration']!,body.name,body.readOnly!==false);});
  router.get('/oauth/callback/:provider','public',async req=>{if(req.query.get('error'))throw new EngineError('FORBIDDEN','Account access was not granted');const credential=await app.oauth.finish(req.params['provider']!,req.query.get('state')??'',req.query.get('code')??'');return {connected:true,credential,message:'Account connected. Close this window and refresh Integrations.'};});

  /* ---------- models ---------- */

  router.get('/api/models/connections', 'admin', () => ({ connections: app.connections.list(), defaults: app.connections.defaults() }));
  router.post('/api/models/connections', 'admin', async (req) => new Reply(201, app.connections.upsert(await req.json())));
  router.put('/api/models/connections/:id', 'admin', async (req) => app.connections.upsert({ ...(await req.json<Record<string, unknown>>()), id: req.params['id']! } as never));
  router.delete('/api/models/connections/:id', 'admin', (req) => ({ deleted: app.connections.remove(req.params['id']!) }));
  router.post('/api/models/connections/:id/test', 'admin', (req) => app.connections.test(req.params['id']!));
  router.put('/api/models/defaults', 'admin', async (req) => {
    const body = await req.json<{ chat?: string | null; embedding?: string | null }>();
    app.connections.setDefaults(body);
    return app.connections.defaults();
  });
  router.get('/api/models', 'admin', async () => {
    const out = [];
    for (const c of app.connections.list()) {
      const t = await app.connections.test(c.id);
      out.push({ connection: c.id, name: c.name, kind: c.kind, ok: t.ok, error: t.error ?? null, models: t.models });
    }
    return out;
  });
  router.post('/api/models/playground', 'admin', async (req) => {
    const body = await req.json<{ connection?: string; model?: string; messages?: LLMMessage[]; temperature?: number; maxTokens?: number }>();
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw new EngineError('BAD_PAYLOAD', 'messages are required');
    const t0 = performance.now();
    const res = await chatCall(app.llm, {
      ref: { ...(body.connection ? { connection: body.connection } : {}), ...(body.model ? { model: body.model } : {}) },
      messages: body.messages.map((m) => ({ role: m.role === 'system' || m.role === 'assistant' ? m.role : 'user', content: String(m.content ?? '') })),
      signal: AbortSignal.timeout(300_000), ...(body.temperature !== undefined ? { temperature: body.temperature } : {}), ...(body.maxTokens ? { maxTokens: body.maxTokens } : {}),
    });
    return { text: res.text, model: res.model, connection: res.connectionId, inputTokens: res.inputTokens, outputTokens: res.outputTokens, latencyMs: Math.round(performance.now() - t0) };
  });

  /* ---------- integrations & credentials ---------- */

  router.get('/api/integrations', 'admin', () => {
    const seen = new Map<string, { id: string; label: string; description: string; icon: string; nodes: string[]; fields: unknown }>();
    for (const n of app.registry.catalog()) {
      if (!n.integration || !n.credentialFields) continue;
      const entry = seen.get(n.integration) ?? { id: n.integration, label: n.label.replace(/ \(SMTP\)$/, ''), description: n.description, icon: n.icon, nodes: [], fields: n.credentialFields };
      entry.nodes.push(n.type);
      seen.set(n.integration, entry);
    }
    return { integrations: [...seen.values()], credentials: app.credentials.list() };
  });
  router.post('/api/credentials', 'admin', async (req) => new Reply(201, app.credentials.upsert(await req.json() as never)));
  router.put('/api/credentials/:id', 'admin', async (req) => app.credentials.upsert({ ...(await req.json<Record<string, unknown>>()), id: req.params['id']! } as never));
  router.delete('/api/credentials/:id', 'admin', (req) => ({ deleted: app.credentials.remove(req.params['id']!) }));

  /* ---------- context: vector databases, documents, memory ---------- */

  router.get('/api/collections', 'admin', (req) => app.vectors.listCollections(req.query.get('kind') === 'memory' ? 'memory' : req.query.get('kind') === 'knowledge' ? 'knowledge' : undefined));
  router.post('/api/collections', 'admin', async (req) => {
    const body = await req.json<{ name?: string; description?: string; kind?: 'knowledge' | 'memory'; embeddingConnection?: string | null; embeddingModel?: string | null }>();
    return new Reply(201, app.vectors.createCollection({
      name: String(body.name ?? ''), ...(body.description ? { description: body.description } : {}), kind: body.kind === 'memory' ? 'memory' : 'knowledge',
      embeddingConnection: body.embeddingConnection ?? null, embeddingModel: body.embeddingModel ?? null,
    }));
  });
  router.get('/api/collections/:name', 'admin', (req) => {
    const c = app.vectors.getCollection(req.params['name']!);
    if (!c) throw new EngineError('NOT_FOUND', 'Collection not found');
    return c;
  });
  router.put('/api/collections/:name', 'admin', async (req) => app.vectors.updateCollection(req.params['name']!, await req.json()));
  router.delete('/api/collections/:name', 'admin', (req) => ({ deleted: app.vectors.deleteCollection(req.params['name']!) }));
  router.post('/api/collections/:name/clear', 'admin', (req) => ({ removed: app.vectors.clear(req.params['name']!) }));
  router.get('/api/collections/:name/records', 'admin', (req) => app.vectors.list(req.params['name']!, {
    limit: num(req.query.get('limit'), 50), offset: num(req.query.get('offset'), 0), ...(req.query.get('documentId') ? { documentId: req.query.get('documentId')! } : {}),
  }));
  router.delete('/api/collections/:name/records/:id', 'admin', (req) => ({ deleted: app.vectors.delete(req.params['name']!, { ids: [req.params['id']!] }) }));
  router.post('/api/collections/:name/search', 'admin', async (req) => {
    const name = req.params['name']!;
    const body = await req.json<{ query?: string; mode?: 'vector' | 'keyword' | 'hybrid'; limit?: number; certainty?: number; alpha?: number; filter?: unknown }>();
    const info = app.vectors.getCollection(name);
    if (!info) throw new EngineError('NOT_FOUND', 'Collection not found');
    const mode = body.mode ?? 'hybrid';
    const query = String(body.query ?? '');
    const t0 = performance.now();
    let vector: number[] | undefined;
    if (mode !== 'keyword' && info.records > 0) {
      const res = await embed(app.llm, { ...(info.embeddingConnection ? { connection: info.embeddingConnection } : {}), ...(info.embeddingModel ? { model: info.embeddingModel } : {}) }, [query], AbortSignal.timeout(120_000));
      vector = res.vectors[0];
    }
    const filter = parseFilter(body.filter);
    const hits = info.records === 0 ? [] : app.vectors.search(name, {
      mode, query, limit: body.limit ?? 10, ...(vector ? { vector } : {}), ...(body.certainty !== undefined ? { certainty: body.certainty } : {}),
      ...(body.alpha !== undefined ? { alpha: body.alpha } : {}), ...(filter ? { filter } : {}),
    });
    return { hits, latencyMs: Math.round(performance.now() - t0) };
  });
  router.get('/api/collections/:name/documents', 'admin', (req) => app.knowledge.list(req.params['name']!));
  router.post('/api/collections/:name/documents', 'admin', async (req) => new Reply(202, app.knowledge.ingest({ ...(await req.json<Record<string, unknown>>()), collection: req.params['name']! } as never)));
  router.delete('/api/documents/:id', 'admin', (req) => ({ deleted: app.knowledge.remove(req.params['id']!) }));

  /* ---------- tables ---------- */

  router.get('/api/tables', 'admin', () => app.tables.list());
  router.post('/api/tables', 'admin', async (req) => {
    const body = await req.json<{ name?: string; columns?: { name: string; type: never }[] }>();
    return new Reply(201, app.tables.create(String(body.name ?? ''), Array.isArray(body.columns) ? body.columns : []));
  });
  router.delete('/api/tables/:name', 'admin', (req) => ({ deleted: app.tables.drop(req.params['name']!) }));
  router.get('/api/tables/:name/rows', 'admin', (req) => app.tables.select(req.params['name']!, { limit: num(req.query.get('limit'), 100), offset: num(req.query.get('offset'), 0), orderBy: [{ column: 'id', order: 'desc' }] }));
  router.post('/api/tables/:name/rows', 'admin', async (req) => app.tables.insert(req.params['name']!, (await req.json<{ data?: Record<string, unknown> }>()).data ?? {}));
  router.put('/api/tables/:name/rows/:row', 'admin', async (req) => app.tables.update(req.params['name']!, (await req.json<{ data?: Record<string, unknown> }>()).data ?? {}, { conditions: [{ column: 'id', operator: '=', value: Number(req.params['row']) }] }));
  router.delete('/api/tables/:name/rows/:row', 'admin', (req) => app.tables.delete(req.params['name']!, { conditions: [{ column: 'id', operator: '=', value: Number(req.params['row']) }] }));

  /* ---------- files ---------- */

  router.post('/api/files', 'admin', async (req) => {
    const bytes = await req.bytes(MAX_UPLOAD_BYTES);
    const header = req.headers['x-filename'];
    const name = typeof header === 'string' ? decodeURIComponent(header) : 'upload';
    return new Reply(201, app.files.save(bytes, name, String(req.headers['content-type'] ?? 'application/octet-stream')));
  });
  router.get('/assets/:id','public',async req=>{const id=req.params['id']!;if(!app.verifyFileToken(id,req.query.get('token')??''))throw new EngineError('FORBIDDEN','Invalid or expired file token');const file=await app.files.read(id);req.res.writeHead(200,{'content-type':file.mime,'content-length':String(file.bytes.length),'x-content-type-options':'nosniff','cache-control':'private, no-store','content-security-policy':"default-src 'none'; sandbox"});req.res.end(file.bytes);return HANDLED;});
  router.get('/api/files/:id/link','admin',(req)=>({key:req.params['id'],url:app.fileUrl(req.params['id']!)}));
  router.get('/api/files', 'admin', () => app.files.list());
  router.delete('/api/files/:id', 'admin', (req) => ({ deleted: app.files.remove(req.params['id']!) }));

  /* ---------- prompts ---------- */

  router.get('/api/prompts', 'admin', () => app.prompts.list());
  router.post('/api/prompts', 'admin', async (req) => new Reply(201, app.prompts.upsert(await req.json() as never)));
  router.put('/api/prompts/:id', 'admin', async (req) => app.prompts.upsert({ ...(await req.json<Record<string, unknown>>()), id: req.params['id']! } as never));
  router.delete('/api/prompts/:id', 'admin', (req) => ({ deleted: app.prompts.remove(req.params['id']!) }));

  /* ---------- settings, secrets, keys ---------- */

  router.get('/api/settings', 'admin', () => ({
    project: app.project.info(), secrets: app.project.secretNames(), env: app.project.env(),
    retention: app.settings.get('runs.retention', { maxRuns: 20_000, maxAgeDays: 30 }),
    auth: { adminEnabled: app.apiKeys.adminEnabled, executeEnabled: app.apiKeys.executeEnabled },
  }));
  router.put('/api/settings/project', 'admin', async (req) => app.project.setInfo(await req.json()));
  router.put('/api/settings/env', 'admin', async (req) => app.project.setEnv((await req.json<{ vars?: Record<string, unknown> }>()).vars ?? {}));
  router.put('/api/settings/secrets/:name', 'admin', async (req) => {
    const body = await req.json<{ value?: unknown }>();
    if (typeof body.value !== 'string') throw new EngineError('BAD_PAYLOAD', 'value must be a string');
    app.project.setSecret(req.params['name']!, body.value);
    return { names: app.project.secretNames() };
  });
  router.delete('/api/settings/secrets/:name', 'admin', (req) => ({ deleted: app.project.deleteSecret(req.params['name']!) }));
  router.put('/api/settings/retention', 'admin', async (req) => {
    const body = await req.json<{ maxRuns?: number; maxAgeDays?: number }>();
    const policy = { maxRuns: Math.max(0, Math.trunc(Number(body.maxRuns ?? 20_000))), maxAgeDays: Math.max(0, Math.trunc(Number(body.maxAgeDays ?? 30))) };
    app.settings.set('runs.retention', policy);
    return { ...policy, pruned: app.pruneRuns() };
  });
  router.get('/api/keys', 'admin', () => app.apiKeys.list());
  router.post('/api/keys', 'admin', async (req) => {
    const body = await req.json<{ name?: string; scope?: 'admin' | 'execute' }>();
    return new Reply(201, app.apiKeys.create(String(body.name ?? ''), body.scope ?? 'execute'));
  });
  router.delete('/api/keys/:id', 'admin', (req) => ({ revoked: app.apiKeys.revoke(req.params['id']!) }));

  /* ---------- export / import of the whole project ---------- */

  router.post('/api/import','admin',async req=>{
    const b=await req.json<{format:string;version:number;flows:{id:string;name:string;definition:unknown}[]}>();
    if(b.format!=='jasmine-project'||b.version!==1||!Array.isArray(b.flows))throw new EngineError('BAD_PAYLOAD','Provide a Jasmine project export');
    const flows=await app.workspace.saveMany(b.flows);return {imported:flows.map(f=>app.flowSummary(f)),message:'Imported drafts only. Review configuration and deploy each flow explicitly.'};
  });

  router.get('/api/export', 'admin', () => ({
    format: 'jasmine-project', version: 1, exportedAt: new Date().toISOString(), project: app.project.info(),
    flows: app.workspace.list().map((f) => ({ id: f.id, name: f.name, definition: f.definition })),
    prompts: app.prompts.list(), env: app.project.env(),
    collections: app.vectors.listCollections().map((c) => ({ name: c.name, description: c.description, kind: c.kind, embeddingConnection: c.embeddingConnection, embeddingModel: c.embeddingModel })),
    tables: app.tables.list().map((t) => ({ name: t.name, columns: t.columns })),
  }));
}
