import { BlockList, isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { registerMcp } from './mcp.ts';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Jasmine } from '../app.ts';
import { EngineError, toEngineError } from '../errors.ts';
import { createApi } from './graphql.ts';
import { errorBody, Reply, HANDLED, readJson, readBody, Router, send, statusFor, RateLimiter, type Access, type Req } from './http.ts';
import { sessionToken } from '../service/sessions.ts';
import { registerPublic } from './public.ts';
import { registerRest } from './rest.ts';

export interface ServerOptions {
  /** Required `x-project-id` header value on authenticated routes. */
  projectId?: string;
  maxBodyBytes?: number;
  ipAllowlist?: string[];
}

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
const STUDIO_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";
const SPA_PREFIXES = ['/', '/studio', '/flows', '/context', '/models', '/integrations', '/deployments', '/logs', '/alerts', '/reports', '/settings', '/playground', '/prompts', '/docs', '/templates', '/setup', '/hosting'];

const CORS_HEADERS = 'authorization, content-type, x-project-id, x-api-key, idempotency-key, x-bypass-cache, x-jasmine-signature';

/** The lowercase name in a Host header (or a JASMINE_ALLOWED_HOSTS entry), without its port; '' when it is not a plain host. */
function hostname(value: string | undefined): string {
  const host = value?.trim() ?? '';
  if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?$/i.test(host)) return '';
  return URL.canParse(`http://${host}`) ? new URL(`http://${host}`).hostname : '';
}

const loopbackName = (name: string) =>
  name === 'localhost' || name.endsWith('.localhost') || name === '[::1]' || (isIP(name) === 4 && name.startsWith('127.'));

function bearer(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string' && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  const key = req.headers['x-api-key'];
  return typeof key === 'string' ? key : undefined;
}

async function serveStatic(pathname: string, method: string, res: http.ServerResponse): Promise<boolean> {
  if (method !== 'GET' && method !== 'HEAD') return false;
  let file: string | undefined;
  const clean = path.posix.normalize(decodeURIComponent(pathname));
  if (!clean.includes('..') && !clean.split('/').some((p) => p.startsWith('.')) && path.extname(clean)) {
    const candidate = path.join(PUBLIC_DIR, clean);
    if (candidate.startsWith(PUBLIC_DIR)) {
      try {
        if ((await stat(candidate)).isFile()) file = candidate;
      } catch {
        file = undefined;
      }
    }
  }
  if (!file && !path.extname(clean) && SPA_PREFIXES.some((p) => (p === '/' ? clean === '/' : clean === p || clean.startsWith(`${p}/`)))) {
    file = path.join(PUBLIC_DIR, 'index.html');
  }
  if (!file) return false;
  const body = await readFile(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
    ...(file.endsWith('.html') ? { 'content-security-policy': STUDIO_CSP, 'referrer-policy': 'same-origin' } : {}),
  });
  res.end(method === 'HEAD' ? undefined : body);
  return true;
}

export function createServer(app: Jasmine, opts: ServerOptions = {}): http.Server {
  const maxBody = opts.maxBodyBytes ?? 2_000_000;
  const router = new Router();
  const loginLimiter = new RateLimiter(10, 60_000);
  const gatewaySecret = app.config.env?.['JASMINE_GATEWAY_SECRET'];
  const publicUrl = app.config.env?.['PUBLIC_URL'];
  const secureCookie = publicUrl?.startsWith('https://') ?? false;
  const publicHost = URL.canParse(publicUrl ?? '') ? new URL(publicUrl!) : undefined;
  const publicOrigin = publicHost?.origin;
  // Without an admin key, whoever reaches the API is its admin. A page on another site can reach a loopback server
  // under its own host name by DNS rebinding, so a keyless workspace answers only to names that cannot be rebound.
  const extraHosts = new Set([publicHost?.hostname ?? '', ...(app.config.env?.['JASMINE_ALLOWED_HOSTS'] ?? '').split(',').map(hostname)].filter(Boolean));
  const hostAllowed = (req: http.IncomingMessage) => {
    const name = hostname(req.headers.host);
    return !!name && (loopbackName(name) || extraHosts.has(name));
  };
  const sameOrigin = (req: http.IncomingMessage, origin: string) => origin === publicOrigin || origin === `http://${req.headers.host}`;
  /**
   * Writes authorized by a cookie, or by nothing at all in keyless mode, must come from Jasmine's own pages. Browsers
   * send Origin on every write; curl and the SDKs send none, which only keyless mode accepts.
   */
  const checkOrigin = (req: http.IncomingMessage, requireOrigin = true) => {
    const origin = req.headers.origin;
    if ((origin === undefined ? requireOrigin : !sameOrigin(req, origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
      throw new EngineError('FORBIDDEN', 'Requests from other websites are not accepted. Open Jasmine on its own address or configured public URL and try again.');
    }
  };
  // Studio calls its API from its own origin and needs no CORS. Widget routes answer their own preflights (public.ts).
  const preflight = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !sameOrigin(req, origin)) throw new EngineError('FORBIDDEN', 'Other websites cannot call this endpoint from a browser');
    res.writeHead(204, origin === undefined ? {} : {
      'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': CORS_HEADERS, 'access-control-max-age': '600', vary: 'Origin',
    });
    res.end();
  };
  router.get('/api/auth/session', 'public', req => ({
    authenticated: app.sessions.verify(sessionToken(req.headers.cookie)), authRequired: app.apiKeys.adminEnabled,
  }));
  router.post('/api/auth/session', 'public', async req => {
    checkOrigin(req.raw);
    if (!loginLimiter.allow(req.raw.socket.remoteAddress ?? 'unknown')) throw new EngineError('RATE_LIMITED', 'Too many sign-in attempts. Try again in a minute.');
    const body = await req.json<{ apiKey?: unknown }>(8192);
    const token = typeof body.apiKey === 'string' ? app.sessions.create(body.apiKey) : undefined;
    if (!token) throw new EngineError('FORBIDDEN', 'That workspace access key is not valid');
    // Replace a previous session rather than leaving it active until expiry.
    app.sessions.revoke(sessionToken(req.headers.cookie));
    return new Reply(200, { authenticated: true }, { 'set-cookie': app.sessions.cookie(token, secureCookie), 'cache-control': 'no-store' });
  });
  router.delete('/api/auth/session', 'public', req => {
    checkOrigin(req.raw);
    app.sessions.revoke(sessionToken(req.headers.cookie));
    return new Reply(200, { authenticated: false }, { 'set-cookie': app.sessions.cookie('', secureCookie), 'cache-control': 'no-store' });
  });
  const allowed=opts.ipAllowlist?.length?new BlockList():undefined;
  for(const entry of opts.ipAllowlist??[]){const [address,prefix]=entry.split('/');const version=isIP(address??'');if(!version)throw new Error('Invalid IP allowlist');const type=version===4?'ipv4':'ipv6';if(prefix!==undefined)allowed!.addSubnet(address!,Number(prefix),type);else allowed!.addAddress(address!,type);}

  const graphqlApi = createApi(app.deployments, app.runs, app.feedback);

  router.post('/graphql', 'execute', async (req) => {
    const body = await req.json<{ query?: unknown; variables?: unknown; operationName?: unknown }>();
    if (body.variables != null && (typeof body.variables !== 'object' || Array.isArray(body.variables))) throw new EngineError('BAD_PAYLOAD', 'Variables must be an object or null');
    if (body.operationName != null && typeof body.operationName !== 'string') throw new EngineError('BAD_PAYLOAD', 'Operation name must be a string or null');
    if (typeof body.query !== 'string') throw new EngineError('BAD_PAYLOAD', 'Missing query');
    return graphqlApi.execute(body.query, body.variables == null ? undefined : body.variables as Record<string, unknown>, typeof body.operationName === 'string' ? body.operationName : undefined, { scope: req.scope, apiKey: req.apiKey, bypassCache:String(req.headers['x-bypass-cache']??'').toLowerCase()==='true' });
  });
  registerRest(router, app);
  registerMcp(router, app);
  registerPublic(router, app);

  const authorize = (req: http.IncomingMessage, access: Access): Pick<Req, 'scope' | 'apiKey'> => {
    if (access === 'public') return { scope: 'public', apiKey: undefined };
    const token = bearer(req);
    const key = app.apiKeys.verify(token);
    if (token && !key) throw new EngineError('FORBIDDEN', 'Access Denied');
    const session = !token && app.sessions.verify(sessionToken(req.headers.cookie));
    if (!token && !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) {
      if (session) checkOrigin(req);
      else if (!app.apiKeys.adminEnabled) checkOrigin(req, false);
    }
    if (opts.projectId && !session && req.headers['x-project-id'] !== opts.projectId) throw new EngineError('FORBIDDEN', 'Access Denied');
    if (session) return { scope: 'admin', apiKey: undefined };
    if (access === 'admin') {
      if (key?.scope === 'admin' || (!key && !app.apiKeys.adminEnabled)) return { scope: 'admin', apiKey: key };
      throw new EngineError('FORBIDDEN', 'Access Denied');
    }
    if (key) return { scope: key.scope, apiKey: key };
    if (!app.apiKeys.executeEnabled) return { scope: 'admin', apiKey: undefined };
    throw new EngineError('FORBIDDEN', 'Access Denied');
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.url === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true });
    if (gatewaySecret) {
      const given = Buffer.from(String(req.headers['x-jasmine-gateway'] ?? ''));
      const expected = Buffer.from(gatewaySecret);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new EngineError('FORBIDDEN', 'Access Denied');
    }
    const clientAddress=(req.socket.remoteAddress??'').replace(/^::ffff:/,'');
    if(allowed&&!allowed.check(clientAddress,isIP(clientAddress)===4?'ipv4':'ipv6'))throw new EngineError('FORBIDDEN','Client IP is not allowed');
    if (!app.apiKeys.adminEnabled && !hostAllowed(req)) {
      throw new EngineError('FORBIDDEN', 'Without an access key, Jasmine answers only on localhost. Open it at http://localhost or 127.0.0.1, list this host name in JASMINE_ALLOWED_HOSTS, or set JASMINE_API_KEY.');
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const match = router.match(method, url.pathname);
    if (method === 'OPTIONS' && !(match && 'route' in match)) return preflight(req, res);
    if (match && 'route' in match) {
      const { scope, apiKey } = authorize(req, match.route.access);
      const r: Req = {
        method, path: url.pathname, url, params: match.params, query: url.searchParams, headers: req.headers, raw: req, res, scope, apiKey,
        json: <T>(limit = maxBody) => readJson(req, limit) as Promise<T>,
        bytes: (limit = maxBody) => readBody(req, limit),
      };
      const result = await match.route.handler(r);
      if (result === HANDLED) return;
      if (result instanceof Reply) return send(res, result.status, result.body, result.headers);
      return send(res, 200, result === undefined ? { ok: true } : result);
    }
    if (match && 'allowed' in match) return send(res, 405, errorBody(new EngineError('NOT_FOUND', `Use ${match.allowed.join(' or ')}`)), { allow: match.allowed.join(', ') });
    if (await serveStatic(url.pathname, method, res)) return;
    send(res, 404, errorBody(new EngineError('NOT_FOUND', `No route for ${method} ${url.pathname}`)));
  }

  return http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (req.destroyed && !req.complete) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const err = toEngineError(error);
      if (!(error instanceof EngineError)) console.error(error);
      send(res, statusFor(err), errorBody(error));
    });
  });
}

/* ---------------- entry point ---------------- */

async function main() {
  const env = process.env;
  if (env['VERCEL']) throw new Error('Use the Vercel gateway entry point, not the persistent runtime. See docs/VERCEL.md.');
  if (env['JASMINE_GATEWAY_SECRET']) {
    let validOrigin = false;
    try {
      const url = new URL(env['PUBLIC_URL'] ?? '');
      validOrigin = url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
    } catch { /* rejected below */ }
    if (!env['JASMINE_API_KEY'] || env['JASMINE_GATEWAY_SECRET'].length < 32 || !validOrigin) {
      throw new Error('Gateway mode requires JASMINE_API_KEY, a gateway secret of at least 32 characters, and a canonical HTTPS PUBLIC_URL origin. See docs/VERCEL.md.');
    }
  }
  const dataDir = env['JASMINE_DATA_DIR'] ?? path.resolve('.jasmine');
  const app = await Jasmine.create({ dataDir, env, log: (m) => console.log(`[jasmine] ${m}`) });
  if(env['MAIL_PORT'])await app.mailhook.start(Number(env['MAIL_PORT']),env['MAIL_HOST']??'127.0.0.1');
  const port = Number(env['PORT'] ?? 8787);
  const host = env['HOST'] ?? '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback && !app.apiKeys.adminEnabled) {
    console.warn('[jasmine] WARNING: listening on a non-loopback address without an admin API key. Set JASMINE_API_KEY so the Studio is not open to your network. Until then Jasmine answers only on localhost names, PUBLIC_URL and JASMINE_ALLOWED_HOSTS.');
  }
  const server = createServer(app, {...(env['JASMINE_IP_ALLOWLIST']?{ipAllowlist:env['JASMINE_IP_ALLOWLIST'].split(',').map(s=>s.trim()).filter(Boolean)}:{}), ...(env['JASMINE_PROJECT_ID'] ? { projectId: env['JASMINE_PROJECT_ID'] } : {}) });
  server.listen(port, host, () => {
    const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    const chat = app.llm.defaultFor('chat');
    const embedding = app.llm.defaultFor('embedding');
    console.log(`Jasmine Studio:  ${base}/`);
    console.log(`GraphQL API:     ${base}/graphql`);
    console.log(`Models:          chat via ${chat?.name ?? 'none'}, embeddings via ${embedding?.kind === 'builtin' ? 'built-in lexical embeddings' : embedding?.name ?? 'none'} (manage connections at ${base}/models)`);
  });
  const shutdown = () => {
    server.close();
    void app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
