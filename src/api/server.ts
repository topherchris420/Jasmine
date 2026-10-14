import { BlockList, isIP } from 'node:net';
import { registerMcp } from './mcp.ts';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Jasmine } from '../app.ts';
import { EngineError, toEngineError } from '../errors.ts';
import { createApi } from './graphql.ts';
import { errorBody, Reply, HANDLED, readJson, readBody, Router, send, statusFor, type Access, type Req } from './http.ts';
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
const SPA_PREFIXES = ['/', '/studio', '/flows', '/context', '/models', '/integrations', '/deployments', '/logs', '/alerts', '/reports', '/settings', '/playground', '/prompts', '/docs'];

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
  const allowed=opts.ipAllowlist?.length?new BlockList():undefined;
  for(const entry of opts.ipAllowlist??[]){const [address,prefix]=entry.split('/');const version=isIP(address??'');if(!version)throw new Error('Invalid IP allowlist');const type=version===4?'ipv4':'ipv6';if(prefix!==undefined)allowed!.addSubnet(address!,Number(prefix),type);else allowed!.addAddress(address!,type);}

  const graphqlApi = createApi(app.deployments, app.runs, app.feedback);

  router.post('/graphql', 'execute', async (req) => {
    const body = await req.json<{ query?: unknown; variables?: unknown; operationName?: unknown }>();
    if (body.variables != null && (typeof body.variables !== 'object' || Array.isArray(body.variables))) throw new EngineError('BAD_PAYLOAD', 'Variables must be an object or null');
    if (body.operationName != null && typeof body.operationName !== 'string') throw new EngineError('BAD_PAYLOAD', 'Operation name must be a string or null');
    if (typeof body.query !== 'string') throw new EngineError('BAD_PAYLOAD', 'Missing query');
    return graphqlApi.execute(body.query, body.variables == null ? undefined : body.variables as Record<string, unknown>, typeof body.operationName === 'string' ? body.operationName : undefined, { scope: req.scope,bypassCache:String(req.headers['x-bypass-cache']??'').toLowerCase()==='true' });
  });
  registerRest(router, app);
  registerMcp(router, app);
  registerPublic(router, app);

  const authorize = (req: http.IncomingMessage, access: Access): 'admin' | 'execute' | 'public' => {
    if (access === 'public') return 'public';
    const token = bearer(req);
    const key = app.apiKeys.verify(token);
    if (token && !key) throw new EngineError('FORBIDDEN', 'Access Denied');
    if (opts.projectId && req.headers['x-project-id'] !== opts.projectId) throw new EngineError('FORBIDDEN', 'Access Denied');
    if (access === 'admin') {
      if (key?.scope === 'admin' || (!key && !app.apiKeys.adminEnabled)) return 'admin';
      throw new EngineError('FORBIDDEN', 'Access Denied');
    }
    if (key) return key.scope;
    if (!app.apiKeys.executeEnabled) return app.apiKeys.adminEnabled ? 'execute' : 'admin';
    throw new EngineError('FORBIDDEN', 'Access Denied');
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const clientAddress=(req.socket.remoteAddress??'').replace(/^::ffff:/,'');
    if(allowed&&!allowed.check(clientAddress,isIP(clientAddress)===4?'ipv4':'ipv6'))throw new EngineError('FORBIDDEN','Client IP is not allowed');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': String(req.headers.origin ?? '*'), 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-project-id, x-api-key, idempotency-key, x-bypass-cache, x-jasmine-signature', 'access-control-max-age': '600', vary: 'Origin',
      });
      res.end();
      return;
    }
    const match = router.match(method, url.pathname);
    if (match && 'route' in match) {
      const scope = authorize(req, match.route.access);
      const r: Req = {
        method, path: url.pathname, url, params: match.params, query: url.searchParams, headers: req.headers, raw: req, res, scope,
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
  const dataDir = env['JASMINE_DATA_DIR'] ?? path.resolve('.jasmine');
  const app = await Jasmine.create({ dataDir, env, log: (m) => console.log(`[jasmine] ${m}`) });
  if(env['MAIL_PORT'])await app.mailhook.start(Number(env['MAIL_PORT']),env['MAIL_HOST']??'127.0.0.1');
  const port = Number(env['PORT'] ?? 8787);
  const host = env['HOST'] ?? '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback && !app.apiKeys.adminEnabled) {
    console.warn('[jasmine] WARNING: listening on a non-loopback address without an admin API key. Set JASMINE_API_KEY so the Studio is not open to your network.');
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
