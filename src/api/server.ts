import { BlockList, isIP } from 'node:net';
import { registerMcp } from './mcp.ts';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Jasmine } from '../app.ts';
import { EngineError, toEngineError } from '../errors.ts';
import { createApi } from './graphql.ts';
import { errorBody, Reply, HANDLED, normalizeAddress, readJson, readBody, Router, send, statusFor, type Access, type Req } from './http.ts';
import { registerPublic } from './public.ts';
import { registerRest } from './rest.ts';

export interface ServerOptions {
  /** Required `x-project-id` header value on authenticated routes. */
  projectId?: string;
  maxBodyBytes?: number;
  ipAllowlist?: string[];
  /**
   * Extra Host names accepted while no API key protects a route (loopback names and addresses always are).
   * Defaults to `JASMINE_ALLOWED_HOSTS` plus the host of `PUBLIC_URL`. `*` accepts any Host.
   */
  allowedHosts?: string[];
}

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
const STUDIO_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";
const SPA_PREFIXES = ['/', '/studio', '/flows', '/context', '/models', '/integrations', '/deployments', '/logs', '/alerts', '/reports', '/settings', '/playground', '/prompts', '/docs'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function bearer(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string' && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  const key = req.headers['x-api-key'];
  return typeof key === 'string' ? key : undefined;
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** True for 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopbackAddress(address: string | undefined): boolean {
  const ip = normalizeAddress((address ?? '').replace(/^\[|\]$/g, ''));
  const version = isIP(ip);
  return version !== 0 && LOOPBACK.check(ip, version === 4 ? 'ipv4' : 'ipv6');
}

/** Strict parser for JASMINE_IP_ALLOWLIST entries: `address` or `address/prefix` with a decimal prefix in range. */
export function parseIpAllowlist(entries: string[]): BlockList {
  const list = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    const parts = entry.split('/');
    const address = parts[0] ?? '';
    const version = isIP(address);
    if (!version || parts.length > 2) throw new Error(`Invalid IP allowlist entry "${entry}": use an IP address or address/prefix`);
    const type = version === 4 ? 'ipv4' : 'ipv6';
    if (parts.length === 1) {
      list.addAddress(address, type);
      continue;
    }
    const max = version === 4 ? 32 : 128;
    const prefix = parts[1]!;
    if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) throw new Error(`Invalid IP allowlist entry "${entry}": the prefix must be a number from 0 to ${max}`);
    list.addSubnet(address, Number(prefix), type);
  }
  return list;
}

/**
 * Client filter for JASMINE_IP_ALLOWLIST, applied to the connecting socket address (never forwarded headers).
 * Loopback is not exempt: a reverse proxy on the same host connects over loopback for every client.
 */
export function ipFilter(entries: string[]): (address: string | undefined) => boolean {
  const list = parseIpAllowlist(entries);
  return (address) => {
    const ip = normalizeAddress(address ?? '');
    const version = isIP(ip);
    return version !== 0 && list.check(ip, version === 4 ? 'ipv4' : 'ipv6');
  };
}

/** The container health check reads `/api/status` over loopback; that one read passes any IP allowlist. */
function isLocalHealthCheck(req: http.IncomingMessage): boolean {
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0];
  return (method === 'GET' || method === 'HEAD') && path === '/api/status' && isLoopbackAddress(req.socket.remoteAddress);
}

interface HostRule { hostname: string; port?: string; wildcard: boolean }

function parseHostRule(entry: string): HostRule | undefined {
  const text = entry.trim().toLowerCase();
  if (!text) return undefined;
  if (text === '*') return { hostname: '*', wildcard: true };
  const wildcard = text.startsWith('*.');
  try {
    const url = new URL(`http://${wildcard ? text.slice(2) : text}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('not a host');
    return { hostname: url.hostname, ...(url.port ? { port: url.port } : {}), wildcard };
  } catch {
    throw new Error(`Invalid allowed host "${entry}": use a host name such as jasmine.lan, jasmine.lan:8787 or *.example.com`);
  }
}

/** Host names a keyless server answers to: loopback, configured names and PUBLIC_URL's host. */
export function hostChecker(entries: string[]): (hostHeader: string | undefined) => boolean {
  const rules = entries.map(parseHostRule).filter((r): r is HostRule => !!r);
  return (hostHeader) => {
    // Browsers always send Host; a request without one cannot come from a DNS-rebinding page.
    if (hostHeader === undefined) return true;
    if (!/^[A-Za-z0-9._\-[\]:]+$/.test(hostHeader)) return false;
    let url: URL;
    try {
      url = new URL(`http://${hostHeader}`);
    } catch {
      return false;
    }
    const hostname = url.hostname;
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || isLoopbackAddress(hostname)) return true;
    return rules.some((r) => r.hostname === '*'
      || ((r.wildcard ? hostname.endsWith(`.${r.hostname}`) : hostname === r.hostname) && (r.port === undefined || r.port === url.port)));
  };
}

/** The request's Origin, when present, is this server (same scheme://host:port as the Host header) or PUBLIC_URL. */
function sameOrigin(req: http.IncomingMessage, publicOrigin: string | undefined): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (publicOrigin && parsed.origin === publicOrigin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(`${parsed.protocol}//${host}`).host === parsed.host;
  } catch {
    return false;
  }
}

async function serveStatic(pathname: string, method: string, res: http.ServerResponse): Promise<boolean> {
  if (method !== 'GET' && method !== 'HEAD') return false;
  let file: string | undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new EngineError('BAD_PAYLOAD', 'Malformed URL encoding');
  }
  const clean = path.posix.normalize(decoded);
  if (!clean.includes('..') && !clean.includes('\0') && !clean.split('/').some((p) => p.startsWith('.')) && path.extname(clean)) {
    const candidate = path.join(PUBLIC_DIR, clean);
    if (candidate.startsWith(PUBLIC_DIR)) {
      try {
        if ((await stat(candidate)).isFile()) file = candidate;
      } catch {
        file = undefined;
      }
    }
  }
  // Studio deep links (also ones whose last segment contains a dot, like /context/docs.v2) load the app shell.
  // Paths outside the Studio prefixes, such as /js/missing.js, stay 404.
  if (!file && SPA_PREFIXES.some((p) => (p === '/' ? clean === '/' : clean === p || clean.startsWith(`${p}/`)))) {
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
  const allowed = opts.ipAllowlist?.length ? ipFilter(opts.ipAllowlist) : undefined;
  const env = app.config.env ?? {};
  let publicOrigin: string | undefined;
  let publicHost: string[] = [];
  if (env['PUBLIC_URL']) {
    try {
      const u = new URL(env['PUBLIC_URL']);
      publicOrigin = u.origin;
      publicHost = [u.hostname];
    } catch {
      console.warn('[jasmine] WARNING: PUBLIC_URL is not an absolute URL (e.g. https://jasmine.example.com); it is ignored for host and origin checks.');
    }
  }
  const hostAllowed = hostChecker([...(opts.allowedHosts ?? (env['JASMINE_ALLOWED_HOSTS'] ?? '').split(',')), ...publicHost]);

  const graphqlApi = createApi(app.deployments, app.runs, app.feedback);

  router.post('/graphql', 'execute', async (req) => {
    const body = await req.json<{ query?: unknown; variables?: unknown; operationName?: unknown }>();
    if (body.variables != null && (typeof body.variables !== 'object' || Array.isArray(body.variables))) throw new EngineError('BAD_PAYLOAD', 'Variables must be an object or null');
    if (body.operationName != null && typeof body.operationName !== 'string') throw new EngineError('BAD_PAYLOAD', 'Operation name must be a string or null');
    if (typeof body.query !== 'string') throw new EngineError('BAD_PAYLOAD', 'Missing query');
    return graphqlApi.execute(body.query, body.variables == null ? undefined : body.variables as Record<string, unknown>, typeof body.operationName === 'string' ? body.operationName : undefined, { scope: req.scope,bypassCache:String(req.headers['x-bypass-cache']??'').toLowerCase()==='true' });
  });
  registerRest(router, app, { ...(opts.projectId ? { projectId: opts.projectId } : {}) });
  registerMcp(router, app);
  registerPublic(router, app);

  const authorize = (req: http.IncomingMessage, access: Access): 'admin' | 'execute' | 'public' => {
    if (access === 'public') return 'public';
    // Cross-site requests: browsers attach an Origin to every cross-origin POST/PUT/DELETE, including
    // "simple" text/plain or form posts that skip the preflight. Only this server's own pages may change state.
    if (!SAFE_METHODS.has(req.method ?? 'GET') && !sameOrigin(req, publicOrigin)) {
      throw new EngineError('FORBIDDEN', 'Cross-origin requests to the Studio and API are not allowed; call the API from a server or use the public widget endpoints');
    }
    const token = bearer(req);
    const key = app.apiKeys.verify(token);
    if (token && !key) throw new EngineError('FORBIDDEN', 'Access Denied');
    if (opts.projectId && req.headers['x-project-id'] !== opts.projectId) throw new EngineError('FORBIDDEN', 'Access Denied');
    let scope: 'admin' | 'execute';
    if (access === 'admin') {
      if (!(key?.scope === 'admin' || (!key && !app.apiKeys.adminEnabled))) throw new EngineError('FORBIDDEN', 'Access Denied');
      scope = 'admin';
    } else if (key) scope = key.scope;
    else if (!app.apiKeys.executeEnabled) scope = app.apiKeys.adminEnabled ? 'execute' : 'admin';
    else throw new EngineError('FORBIDDEN', 'Access Denied');
    // Without a key, a DNS-rebinding page could reach this server under its own host name; only answer to known hosts.
    if (!key && !hostAllowed(req.headers.host)) {
      throw new EngineError('FORBIDDEN', 'This server has no API key, so it only answers to localhost. Set JASMINE_API_KEY (recommended), or add this host name to JASMINE_ALLOWED_HOSTS.');
    }
    return scope;
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (allowed && !allowed(req.socket.remoteAddress) && !isLocalHealthCheck(req)) throw new EngineError('FORBIDDEN', 'Client IP is not allowed');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      // Only the public widget, webhook and OAuth routes are meant to be called from other origins.
      const requested = String(req.headers['access-control-request-method'] ?? '').toUpperCase();
      if (router.isPublic(url.pathname, requested || undefined)) {
        res.writeHead(204, {
          'access-control-allow-origin': String(req.headers.origin ?? '*'), 'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, x-jasmine-signature, x-webhook-secret', 'access-control-max-age': '600', vary: 'Origin',
        });
      } else res.writeHead(204, { vary: 'Origin' });
      res.end();
      return;
    }
    const match = router.match(method, url.pathname);
    if (match && 'route' in match) {
      const scope = authorize(req, match.route.access);
      const requireJsonType = match.route.access !== 'public';
      const r: Req = {
        method, path: url.pathname, url, params: match.params, query: url.searchParams, headers: req.headers, raw: req, res, scope,
        json: <T>(limit = maxBody) => readJson(req, limit, { requireJsonType }) as Promise<T>,
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

const csv = (value: string | undefined) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

async function main() {
  const env = process.env;
  const dataDir = env['JASMINE_DATA_DIR'] ?? path.resolve('.jasmine');
  const app = await Jasmine.create({ dataDir, env, log: (m) => console.log(`[jasmine] ${m}`) });
  if(env['MAIL_PORT'])await app.mailhook.start(Number(env['MAIL_PORT']),env['MAIL_HOST']??'127.0.0.1');
  const port = Number(env['PORT'] ?? 8787);
  const host = env['HOST'] ?? '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback && !app.apiKeys.adminEnabled) {
    console.warn('[jasmine] WARNING: listening on a non-loopback address without an admin API key. Set JASMINE_API_KEY so the Studio is not open to your network.');
  }
  if (app.apiKeys.executeEnabled && !app.apiKeys.adminEnabled) {
    console.warn('[jasmine] WARNING: execute API keys exist but no admin key, so the Studio and admin API need no key while flow execution does. Create an admin key (Settings → API keys) or set JASMINE_API_KEY.');
  }
  const server = createServer(app, {
    ...(env['JASMINE_IP_ALLOWLIST'] ? { ipAllowlist: csv(env['JASMINE_IP_ALLOWLIST']) } : {}),
    ...(env['JASMINE_PROJECT_ID'] ? { projectId: env['JASMINE_PROJECT_ID'] } : {}),
  });
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
