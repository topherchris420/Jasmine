import type http from 'node:http';
import { isIP } from 'node:net';
import { EngineError, toEngineError } from '../errors.ts';

export type Access = 'public' | 'execute' | 'admin';

export interface Req {
  method: string;
  path: string;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  raw: http.IncomingMessage;
  res: http.ServerResponse;
  scope: 'admin' | 'execute' | 'public';
  /** The API key that authorized the request; undefined for browser sessions, keyless mode and public routes. */
  apiKey: { id: string; scope: 'admin' | 'execute' } | undefined;
  /** The client address rate limits count against (see clientIp). */
  ip: string;
  json<T = Record<string, unknown>>(limit?: number): Promise<T>;
  bytes(limit?: number): Promise<Buffer>;
}

/** Return this from a handler that already wrote its own response (streams, HTML, files). */
export const HANDLED = Symbol('handled');

export class Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;

  constructor(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export type Handler = (req: Req) => unknown;

interface Route {
  method: string;
  parts: string[];
  access: Access;
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, access: Access, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), access, handler });
    return this;
  }

  get(pattern: string, access: Access, handler: Handler) { return this.add('GET', pattern, access, handler); }
  post(pattern: string, access: Access, handler: Handler) { return this.add('POST', pattern, access, handler); }
  put(pattern: string, access: Access, handler: Handler) { return this.add('PUT', pattern, access, handler); }
  delete(pattern: string, access: Access, handler: Handler) { return this.add('DELETE', pattern, access, handler); }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | { allowed: string[] } | undefined {
    const parts = path.split('/').filter(Boolean);
    const allowed: string[] = [];
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const p = route.parts[i]!;
        if (p.startsWith(':')) {
          try {
            params[p.slice(1)] = decodeURIComponent(parts[i]!);
          } catch {
            ok = false;
            break;
          }
        } else if (p !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) return { route, params };
      allowed.push(route.method);
    }
    return allowed.length ? { allowed } : undefined;
  }
}

export async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new EngineError('PAYLOAD_TOO_LARGE', `Body exceeds ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      req.resume();
      throw new EngineError('PAYLOAD_TOO_LARGE', `Body exceeds ${limit} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: http.IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new EngineError('BAD_PAYLOAD', 'Body must be JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new EngineError('BAD_PAYLOAD', 'Body must be a JSON object');
  return parsed as Record<string, unknown>;
}

export function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.destroyed || res.writableEnded) return;
  const json = JSON.stringify(body ?? null);
  if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(json);
}

/** A browser opening a page (rather than a program calling the API) asks for HTML. */
export function acceptsHtml(req: http.IncomingMessage): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && /\btext\/html\b/i.test(String(req.headers.accept ?? ''));
}

export function statusFor(err: EngineError): number {
  switch (err.code) {
    case 'PAYLOAD_TOO_LARGE': return 413;
    case 'NOT_FOUND': return 404;
    case 'CONFLICT': return 409;
    case 'BAD_PAYLOAD':
    case 'COMPILE': return 400;
    case 'FORBIDDEN': return 403;
    case 'OVERLOADED':
    case 'RATE_LIMITED': return 429;
    default: return 500;
  }
}

export function errorBody(err: unknown): { errors: { message: string; extensions: Record<string, unknown> }[] } {
  const e = toEngineError(err);
  const internal = e.code === 'INTERNAL' && !(err instanceof EngineError);
  const extensions: Record<string, unknown> = { code: e.code, retryable: e.retryable };
  if (e.nodeId) extensions['nodeId'] = e.nodeId;
  if (e.code === 'COMPILE' && Array.isArray(e.details)) extensions['diagnostics'] = e.details;
  return { errors: [{ message: internal ? 'Internal server error' : e.message, extensions }] };
}

/** Server-sent events. */
export function openStream(req: http.IncomingMessage, res: http.ServerResponse, headers: Record<string, string> = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...headers });
  res.write(': connected\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  let closed = false;
  const onClose: (() => void)[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    for (const fn of onClose) fn();
    if (!res.writableEnded) res.end();
  };
  res.on('close', close);
  return {
    send(event: string, data: unknown) {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onClose(fn: () => void) {
      if (closed) fn();
      else onClose.push(fn);
    },
    close,
    get closed() {
      return closed;
    },
  };
}

/** Fixed-window limiter for public endpoints (widgets, webhooks). */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(limit: number, windowMs: number, maxKeys = 10_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (entry && entry.reset >= now) return ++entry.count <= this.limit;
    // A new window goes to the end, so the map stays ordered by window start and expired windows come first.
    this.hits.delete(key);
    if (this.hits.size >= this.maxKeys) this.evict(now);
    this.hits.set(key, { count: 1, reset: now + this.windowMs });
    return true;
  }

  /** Bounds memory without handing everyone a fresh window: expired windows go first, then the oldest active ones. */
  private evict(now: number): void {
    for (const [key, { reset }] of this.hits) {
      if (reset >= now && this.hits.size < this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}

/** An address as rate limits count it: IPv4-mapped IPv6 as IPv4, and IPv6 by /64, since a client usually controls a whole /64. */
function limitKey(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (isIP(address) !== 6) return address;
  const [head = '', tail] = address.split('%')[0]!.toLowerCase().split('::');
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups = [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/**
 * Where a request came from, for rate limits. Behind the Vercel gateway every request arrives from Vercel, so the
 * gateway names the client in x-jasmine-client-ip. Pass `viaGateway` only once the request's gateway secret has been
 * verified: otherwise any caller could pick its own address and escape its limit.
 */
export function clientIp(req: http.IncomingMessage, viaGateway = false): string {
  const named = viaGateway ? req.headers['x-jasmine-client-ip'] : undefined;
  return limitKey(typeof named === 'string' && isIP(named.trim()) ? named.trim() : req.socket.remoteAddress ?? 'unknown');
}
