import type http from 'node:http';
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

  /** True when any route for this path (optionally only this method) is public. Used for CORS preflights. */
  isPublic(path: string, method?: string): boolean {
    const found = method ? this.match(method, path) : undefined;
    if (found && 'route' in found) return found.route.access === 'public';
    if (method) return false;
    return ['GET', 'POST', 'PUT', 'DELETE'].some((m) => this.isPublic(path, m));
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

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

/** True when the Content-Type header names JSON (`application/json`, `application/*+json`, with parameters). */
export const isJsonContentType = (value: string | string[] | undefined): boolean => typeof value === 'string' && JSON_TYPE.test(value.trim());

export async function readJson(req: http.IncomingMessage, limit: number, opts: { requireJsonType?: boolean } = {}): Promise<Record<string, unknown>> {
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  // Browsers can send text/plain and form bodies cross-site without a preflight; JSON APIs refuse them.
  if (opts.requireJsonType && !isJsonContentType(req.headers['content-type'])) throw new EngineError('BAD_PAYLOAD', 'Content-Type must be application/json');
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

/**
 * Fixed-window limiter for public endpoints (widgets, webhooks). When the table is full, expired windows
 * are dropped first and then the windows closest to expiry; live counters are never wiped wholesale.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;

  constructor(limit: number, windowMs: number, maxEntries = 100_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.hits.size;
  }

  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (entry && entry.reset >= now) {
      entry.count++;
      return entry.count <= this.limit;
    }
    if (entry) this.hits.delete(key);
    if (this.hits.size >= this.maxEntries) this.evict(now);
    // Insertion order equals window start order, so the oldest entries expire first.
    this.hits.set(key, { count: 1, reset: now + this.windowMs });
    return true;
  }

  private evict(now: number): void {
    for (const [key, entry] of this.hits) if (entry.reset < now) this.hits.delete(key);
    const target = Math.floor(this.maxEntries * 0.9);
    for (const key of this.hits.keys()) {
      if (this.hits.size <= target) break;
      this.hits.delete(key);
    }
  }
}

/** Expands an IPv6 address into eight 16-bit groups, or undefined when it is not IPv6. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.split('%')[0]!.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : undefined;
}

/** Normalizes a socket address: IPv4-mapped IPv6 becomes plain IPv4. */
export function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1]! : address;
}

/**
 * Rate-limit identity for a client: its IPv4 address, or its IPv6 /64 prefix (one subscriber usually
 * controls a whole /64, so per-address keys would let a single client rotate around the limit).
 */
export function clientKey(address: string | undefined): string {
  if (!address) return 'unknown';
  const normal = normalizeAddress(address);
  if (!normal.includes(':')) return normal;
  const groups = ipv6Groups(normal);
  return groups ? `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64` : normal;
}

export const clientIp = (req: http.IncomingMessage) => clientKey(req.socket.remoteAddress);
