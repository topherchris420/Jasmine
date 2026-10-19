import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Jasmine } from '../app.ts';
import { EngineError } from '../errors.ts';
import { collectRefs } from '../flow/template.ts';
import type { DeployedVersion } from '../service/deployments.ts';
import type { ExecuteResponse } from '../service/runs.ts';
import { clientIp, HANDLED, openStream, RateLimiter, readBody, Reply, type Req, type Router } from './http.ts';

const SESSION_ID = /^[A-Za-z0-9_-]{8,100}$/;
const limiter = new RateLimiter(60, 60_000);

function deployedWithTrigger(app: Jasmine, flowId: string, types: string[]): DeployedVersion {
  const d = app.deployments.getActive(flowId);
  const trigger = d?.plan.nodes.get(d.plan.triggerId)?.node;
  if (!d || !trigger || !types.includes(trigger.type)) throw new EngineError('NOT_FOUND', 'Workflow not found!');
  return d;
}

const triggerValues = (d: DeployedVersion) => d.plan.nodes.get(d.plan.triggerId)!.node.values;

function allowedDomains(d: DeployedVersion): string[] {
  const raw = triggerValues(d)['domains'];
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : ['*']).map((x) => String(x).trim()).filter(Boolean);
  return list.length ? list : ['*'];
}

function originAllowed(origin: string | undefined, domains: string[]): boolean {
  if (!origin || domains.includes('*')) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return domains.some((d) => {
    const clean = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return clean.startsWith('*.') ? host === clean.slice(2) || host.endsWith(clean.slice(1)) : host === clean;
  });
}

function sameOrigin(req: Req, origin: string | undefined): boolean {
  if (!origin || !req.headers.host) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function cors(req: Req, d: DeployedVersion): Record<string, string> {
  const origin = req.headers.origin;
  // The hosted widget pages call the API from Jasmine's own origin, which is always allowed.
  if (sameOrigin(req, origin)) return {};
  if (!originAllowed(origin, allowedDomains(d))) throw new EngineError('FORBIDDEN', 'This site is not allowed to use the widget');
  return origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
}

/** A CORS preflight for a public route; `headers` are what its callers may send. */
function preflight(req: Req, allow: Record<string, string>, headers: string): typeof HANDLED {
  req.res.writeHead(204, { ...allow, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': headers, 'access-control-max-age': '600' });
  req.res.end();
  return HANDLED;
}

function limit(req: Req, key: string) {
  if (!limiter.allow(`${clientIp(req.raw)}:${key}`)) throw new EngineError('RATE_LIMITED', 'Too many requests; slow down');
}

/** Node ids whose streamed tokens become the visible reply (what the response node shows). */
function replyNodes(d: DeployedVersion): Set<string> {
  const ids = new Set<string>();
  for (const id of d.plan.responseIds) for (const ref of collectRefs(d.plan.nodes.get(id)!.node.values)) ids.add(ref.nodeId);
  return ids;
}

function chatOutput(res: ExecuteResponse) {
  const out = (res.output ?? {}) as Record<string, unknown>;
  const content = typeof out['content'] === 'string' ? out['content'] : res.status === 'success' && res.output != null ? JSON.stringify(res.output) : '';
  return { content, references: out['references'] ?? [], attachments: [], timestamp: new Date().toISOString(), type: 'text' };
}

export function registerPublic(router: Router, app: Jasmine): void {
  /* ---------- webhooks ---------- */

  const webhook = async (req: Req) => {
    const flowId = req.params['flowId']!;
    const d = deployedWithTrigger(app, flowId, ['webhookTriggerNode']);
    limit(req, `webhook:${flowId}`);
    const raw = await readBody(req.raw, 1_000_000);
    const secret = String(triggerValues(d)['webhookSecret'] ?? '');
    if (secret) {
      const header = String(req.headers['x-jasmine-signature'] ?? req.headers['x-webhook-secret'] ?? req.query.get('secret') ?? '');
      const expected = header.startsWith('sha256=') ? `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` : secret;
      const a = Buffer.from(header);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new EngineError('FORBIDDEN', 'Invalid webhook signature');
    }
    const type = String(req.headers['content-type'] ?? '');
    let payload: unknown = {};
    const text = raw.toString('utf8');
    if (text.trim()) {
      if (type.includes('application/x-www-form-urlencoded')) payload = Object.fromEntries(new URLSearchParams(text));
      else {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { body: text };
        }
      }
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) payload = { body: payload };
    const mode = req.query.get('mode') === 'async' ? 'async' : 'realtime';
    const res = await app.runs.executeWorkflow(flowId, payload, { mode, source: 'webhook' });
    return new Reply(mode === 'async' ? 202 : 200, { status: res.status, requestId: res.requestId, result: res.result, ...(res.error ? { error: res.error } : {}) });
  };
  router.post('/webhooks/:flowId', 'public', webhook);
  router.post('/api/webhook/:flowId', 'public', webhook);
  // Webhooks are public by design and checked by their secret, so any site may send one.
  const webhookPreflight = (req: Req) => preflight(req, req.headers.origin ? { 'access-control-allow-origin': req.headers.origin, vary: 'Origin' } : {}, 'content-type, x-jasmine-signature, x-webhook-secret');
  router.add('OPTIONS', '/webhooks/:flowId', 'public', webhookPreflight);
  router.add('OPTIONS', '/api/webhook/:flowId', 'public', webhookPreflight);

  /* ---------- chat widget ---------- */

  router.get('/api/chat/:flowId/config', 'public', (req) => {
    const d = deployedWithTrigger(app, req.params['flowId']!, ['chatTriggerNode', 'askTriggerNode']);
    const v = triggerValues(d);
    const config = (v['chatConfig'] ?? v['askConfig'] ?? {}) as Record<string, unknown>;
    return new Reply(200, { flowId: d.flowId, mode: d.plan.nodes.get(d.plan.triggerId)!.node.type === 'askTriggerNode' ? 'ask' : 'chat', ...config }, cors(req, d));
  });

  router.get('/api/chat/:flowId/history', 'public', (req) => {
    const d = deployedWithTrigger(app, req.params['flowId']!, ['chatTriggerNode']);
    const sessionId = req.query.get('sessionId') ?? '';
    if (!SESSION_ID.test(sessionId)) throw new EngineError('BAD_PAYLOAD', 'Invalid sessionId');
    return new Reply(200, app.chat.history(d.flowId, sessionId, 50), cors(req, d));
  });

  const chatHandler = (kind: 'chat' | 'ask') => async (req: Req) => {
    const flowId = req.params['flowId']!;
    const d = deployedWithTrigger(app, flowId, [kind === 'chat' ? 'chatTriggerNode' : 'askTriggerNode']);
    const headers = cors(req, d);
    limit(req, `${kind}:${flowId}`);
    const body = await req.json<{ chatMessage?: unknown; message?: unknown; sessionId?: unknown; conversationId?: unknown; userId?: unknown; stream?: unknown; chatHistory?: unknown }>();
    const message = String(body.chatMessage ?? body.message ?? '').trim();
    if (!message) throw new EngineError('BAD_PAYLOAD', 'chatMessage is required');
    if (message.length > 20_000) throw new EngineError('BAD_PAYLOAD', 'Message is too long');
    const given = String(body.sessionId ?? body.conversationId ?? '');
    const sessionId = SESSION_ID.test(given) ? given : randomUUID();
    const userId = typeof body.userId === 'string' ? body.userId.slice(0, 200) : '';
    const history = app.chat.history(flowId, sessionId, 20).map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp, sessionId }));
    const payload = kind === 'chat'
      ? { chatMessage: message, message, chatHistory: history, sessionId, userId }
      : { message, chatMessage: message, conversationId: sessionId, chatHistory: history, sessionId, userId };
    const finish = (res: ExecuteResponse) => {
      const output = chatOutput(res);
      app.chat.append(flowId, sessionId, 'user', message, res.requestId);
      if (res.status === 'success') app.chat.append(flowId, sessionId, 'assistant', output.content, res.requestId);
      return { status: res.status, requestId: res.requestId, sessionId, output, ...(res.error ? { error: { message: res.error.message } } : {}) };
    };
    if (body.stream === true) {
      const requestId = randomUUID();
      const visible = replyNodes(d);
      const stream = openStream(req.raw, req.res, headers);
      stream.send('session', { sessionId, requestId });
      const unsubscribe = app.runs.events.subscribe(requestId, (e) => {
        if (e.type === 'node' && e.event.type === 'node.token' && (visible.size === 0 || visible.has(e.nodeId))) stream.send('token', { text: e.event.data });
        if (e.type === 'node' && e.event.type === 'node.progress') stream.send('progress', { nodeId: e.nodeId, data: e.event.data });
      });
      stream.onClose(unsubscribe);
      try {
        const res = await app.runs.executeWorkflow(flowId, payload, { mode: 'realtime', source: kind, requestId });
        stream.send('message', finish(res));
      } catch (e) {
        stream.send('error', { message: (e as Error).message });
      } finally {
        unsubscribe();
        stream.close();
      }
      return HANDLED;
    }
    const res = await app.runs.executeWorkflow(flowId, payload, { mode: 'realtime', source: kind });
    return new Reply(200, finish(res), headers);
  };
  router.post('/api/chat/:flowId', 'public', chatHandler('chat'));
  router.post('/api/ask/:flowId', 'public', chatHandler('ask'));

  router.post('/api/search/:flowId', 'public', async (req) => {
    const flowId = req.params['flowId']!;
    const d = deployedWithTrigger(app, flowId, ['searchTriggerNode']);
    const headers = cors(req, d);
    limit(req, `search:${flowId}`);
    const body = await req.json<{ searchQuery?: unknown; query?: unknown }>();
    const searchQuery = String(body.searchQuery ?? body.query ?? '').trim().slice(0, 2000);
    if (!searchQuery) throw new EngineError('BAD_PAYLOAD', 'searchQuery is required');
    const res = await app.runs.executeWorkflow(flowId, { searchQuery }, { mode: 'realtime', source: 'search' });
    const out = (res.output ?? {}) as { results?: unknown };
    return new Reply(200, { status: res.status, requestId: res.requestId, results: Array.isArray(out.results) ? out.results : [], ...(res.error ? { error: { message: res.error.message } } : {}) }, headers);
  });

  // Sites embedding a widget call these routes directly; their preflights follow the trigger's allowed domains.
  const widgetPreflight = (types: string[]) => (req: Req) => preflight(req, cors(req, deployedWithTrigger(app, req.params['flowId']!, types)), 'content-type');
  router.add('OPTIONS', '/api/chat/:flowId/config', 'public', widgetPreflight(['chatTriggerNode', 'askTriggerNode']));
  router.add('OPTIONS', '/api/chat/:flowId/history', 'public', widgetPreflight(['chatTriggerNode']));
  router.add('OPTIONS', '/api/chat/:flowId', 'public', widgetPreflight(['chatTriggerNode']));
  router.add('OPTIONS', '/api/ask/:flowId', 'public', widgetPreflight(['askTriggerNode']));
  router.add('OPTIONS', '/api/search/:flowId', 'public', widgetPreflight(['searchTriggerNode']));

  /* ---------- hosted widget pages ---------- */

  const page = (file: string, types: string[]) => async (req: Req) => {
    const d = deployedWithTrigger(app, req.params['flowId']!, types);
    const domains = allowedDomains(d);
    const ancestors = domains.includes('*') ? '*' : ["'self'", ...domains.map((x) => (x.includes('://') ? x : `https://${x} http://${x}`))].join(' ');
    const html = await readFile(new URL(`../../public/apps/${file}`, import.meta.url), 'utf8');
    req.res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; frame-ancestors ${ancestors}`,
    });
    req.res.end(html);
    return HANDLED;
  };
  router.get('/apps/chat/:flowId', 'public', page('chat.html', ['chatTriggerNode', 'askTriggerNode']));
  router.get('/apps/search/:flowId', 'public', page('search.html', ['searchTriggerNode']));

  /* ---------- REST execution API ---------- */

  router.post('/api/v1/flows/:flowId/execute', 'execute', async (req) => {
    const body = await req.json<{ payload?: unknown; mode?: unknown; idempotencyKey?: unknown; version?: unknown }>();
    if (body.mode !== undefined && body.mode !== 'async' && body.mode !== 'realtime') throw new EngineError('BAD_PAYLOAD', 'mode must be realtime or async');
    const key = req.headers['idempotency-key'] ?? body.idempotencyKey;
    if (key !== undefined && (typeof key !== 'string' || key.length < 1 || key.length > 200)) throw new EngineError('BAD_PAYLOAD', 'Idempotency-Key must be a string of 1–200 characters');
    if (req.headers['idempotency-key'] !== undefined && body.idempotencyKey !== undefined && req.headers['idempotency-key'] !== body.idempotencyKey) throw new EngineError('BAD_PAYLOAD', 'Header and body idempotency keys must match');
    if (body.version !== undefined && (typeof body.version !== 'string' || !body.version.trim())) throw new EngineError('BAD_PAYLOAD', 'version must be a nonempty string');
    return app.runs.executeWorkflow(req.params['flowId']!, body.payload ?? {}, {
      ...(body.mode === 'async' || body.mode === 'realtime' ? { mode: body.mode } : {}),
      ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
      ...(typeof body.version === 'string' ? { version: body.version } : {}),
      source: 'api',
      bypassCache:String(req.headers['x-bypass-cache']??'').toLowerCase()==='true',
    });
  });
  router.get('/api/v1/runs/:requestId', 'execute', (req) => app.runs.checkStatus(req.params['requestId']!));
  router.get('/api/v1/runs/:requestId/trace', 'execute', (req) => ({ trace: app.runs.trace(req.params['requestId']!) }));
  router.post('/api/v1/runs/:requestId/retry', 'execute', (req) => app.runs.retryWorkflow(req.params['requestId']!));
  router.post('/api/v1/runs/:requestId/cancel', 'execute', (req) => ({ cancelled: app.runs.cancel(req.params['requestId']!) }));
}
