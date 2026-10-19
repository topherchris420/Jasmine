import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline, Readable, Transform, type TransformCallback } from 'node:stream';
import zlib from 'node:zlib';
import { EngineError } from '../errors.ts';

/*
 * Egress guard for flow-originated HTTP requests.
 *
 * Flow URLs often come straight from a request payload (a page to index, a document to download), so
 * without a guard anyone who can run a flow can point it at the runtime's own network. The address
 * check runs inside the socket's DNS lookup, so the address checked is the address connected to: a
 * hostname cannot pass a check and then resolve somewhere else (DNS rebinding). Redirects are followed
 * here, one hop at a time, and every hop is checked again.
 */

export type AddressClass = 'blocked' | 'private' | 'public';

export interface EgressPolicy {
  /** Whether flows may reach loopback, RFC 1918, CGNAT and unique-local addresses. */
  privateNetworks: 'allow' | 'deny';
  /** Hostnames (`wiki.internal`, `*.corp.example`), addresses and CIDR ranges reachable even under deny. */
  allow: string[];
  /** How `privateNetworks` was chosen: set explicitly, or the default for a hosted or a local runtime. */
  origin?: 'env' | 'hosted' | 'local';
}

/* ---------------- addresses ---------------- */

interface Ip { v6: boolean; value: bigint }
interface Range { v6: boolean; value: bigint; prefix: number }

function parseIp(text: string): Ip | undefined {
  const s = text.replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '');
  if (net.isIPv4(s)) return { v6: false, value: s.split('.').reduce((n, octet) => (n << 8n) | BigInt(octet), 0n) };
  if (!net.isIPv6(s)) return undefined;
  let text6 = s.toLowerCase();
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text6);
  if (dotted) {
    const v4 = parseIp(dotted[2]!)!.value;
    text6 = `${dotted[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head = '', tail] = text6.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return { v6: true, value: groups.reduce((n, group) => (n << 16n) | BigInt(parseInt(group, 16)), 0n) };
}

function parseRange(text: string): Range | undefined {
  const [address = '', bits, extra] = text.split('/');
  const ip = extra === undefined && !address.includes('%') ? parseIp(address) : undefined;
  if (!ip) return undefined;
  const width = ip.v6 ? 128 : 32;
  const prefix = bits === undefined ? width : /^\d{1,3}$/.test(bits) ? Number(bits) : -1;
  if (prefix < 0 || prefix > width) return undefined;
  return { v6: ip.v6, prefix, value: ip.value >> BigInt(width - prefix) };
}

const inRange = (ip: Ip, r: Range) => ip.v6 === r.v6 && ip.value >> BigInt((ip.v6 ? 128 : 32) - r.prefix) === r.value;
const ranges = (list: string[]) => list.map((r) => parseRange(r)!);

/**
 * Never reachable from flows, whatever the policy: unspecified, link-local (cloud metadata lives at
 * 169.254.169.254), the Alibaba and AWS IPv6 metadata addresses, multicast, broadcast and reserved space.
 */
const ALWAYS_BLOCKED = ranges(['0.0.0.0/8', '169.254.0.0/16', '100.100.100.200/32', '224.0.0.0/4', '240.0.0.0/4', '::/128', 'fe80::/10', 'fd00:ec2::254/128', 'ff00::/8']);
/** This machine and its networks: loopback, RFC 1918, CGNAT, IETF protocol and benchmarking space, unique-local and site-local IPv6. */
const PRIVATE = ranges(['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '192.0.0.0/24', '198.18.0.0/15', '::1/128', 'fc00::/7', 'fec0::/10']);
const LOOPBACK = ranges(['127.0.0.0/8', '::1/128']);
/** Metadata services by name, refused before any lookup. */
const METADATA_HOSTS = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal']);

/**
 * The IPv4 address an IPv6 address stands for: mapped (::ffff:0:0/96), translated (::ffff:0:0:0/96),
 * compatible (::/96), NAT64 (64:ff9b::/96, 64:ff9b:1::/48) or 6to4 (2002::/16).
 */
function embeddedIPv4(v6: bigint): bigint | undefined {
  const low = v6 & 0xffffffffn;
  const top = v6 >> 32n;
  if (top === 0xffffn || top === 0xffff0000n || top === 0x0064ff9b0000000000000000n) return low;
  if (top === 0n && low > 1n) return low;
  if (v6 >> 80n === 0x0064ff9b0001n) return low;
  if (v6 >> 112n === 0x2002n) return (v6 >> 80n) & 0xffffffffn;
  return undefined;
}

const asIPv4 = (ip: Ip): Ip | undefined => {
  const v4 = ip.v6 ? embeddedIPv4(ip.value) : undefined;
  return v4 === undefined ? undefined : { v6: false, value: v4 };
};

function classify(ip: Ip): AddressClass {
  if (ALWAYS_BLOCKED.some((r) => inRange(ip, r))) return 'blocked';
  const v4 = asIPv4(ip);
  if (v4) return classify(v4);
  return PRIVATE.some((r) => inRange(ip, r)) ? 'private' : 'public';
}

/** Whether flows may never reach an address, may reach it only when private egress is allowed, or may always reach it. */
export function classifyAddress(address: string): AddressClass {
  const ip = parseIp(address);
  return ip ? classify(ip) : 'blocked';
}

/* ---------------- policy ---------------- */

const HOSTNAME = /^(?:\*\.)?(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

function allowEntry(raw: string): string {
  const entry = raw.trim().toLowerCase().replace(/\.$/, '');
  if (parseRange(entry)) return entry;
  // A last label of digits would be read as an IPv4 address by the URL parser, never as a hostname.
  if (HOSTNAME.test(entry) && !/(?:^|\.)\d+$/.test(entry)) return entry;
  throw new EngineError('BAD_PAYLOAD', `JASMINE_EGRESS_ALLOW entry "${raw.trim().slice(0, 100)}" is not a hostname, IP address or CIDR range`);
}

/** A runtime other people reach: behind the Vercel gateway, or published at a PUBLIC_URL that is not loopback. */
function hostedRuntime(env: Record<string, string | undefined>): boolean {
  if (env['JASMINE_GATEWAY_SECRET']) return true;
  const publicUrl = env['PUBLIC_URL']?.trim();
  if (!publicUrl) return false;
  let host: string;
  try {
    host = new URL(publicUrl).hostname;
  } catch {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  const ip = parseIp(host);
  return !ip || !LOOPBACK.some((r) => inRange(ip, r) || inRange(asIPv4(ip) ?? ip, r));
}

/**
 * JASMINE_PRIVATE_EGRESS (allow | deny) and JASMINE_EGRESS_ALLOW (comma-separated hostnames and CIDRs).
 * Without a setting, a hosted runtime denies private networks and a local one allows them.
 */
export function egressPolicyFromEnv(env: Record<string, string | undefined>): EgressPolicy {
  const setting = env['JASMINE_PRIVATE_EGRESS']?.trim().toLowerCase();
  if (setting && setting !== 'allow' && setting !== 'deny') throw new EngineError('BAD_PAYLOAD', 'JASMINE_PRIVATE_EGRESS must be allow or deny');
  const allow = (env['JASMINE_EGRESS_ALLOW'] ?? '').split(',').filter((e) => e.trim()).map(allowEntry);
  if (setting === 'allow' || setting === 'deny') return { privateNetworks: setting, allow, origin: 'env' };
  return hostedRuntime(env) ? { privateNetworks: 'deny', allow, origin: 'hosted' } : { privateNetworks: 'allow', allow, origin: 'local' };
}

export function describeEgressPolicy(policy: EgressPolicy): string {
  const why = policy.origin === 'hosted' ? 'default for a hosted runtime' : policy.origin === 'local' ? 'default for a local runtime' : 'JASMINE_PRIVATE_EGRESS';
  const except = policy.privateNetworks === 'deny' && policy.allow.length ? ` except ${policy.allow.join(', ')}` : '';
  return `flows may ${policy.privateNetworks === 'allow' ? '' : 'not '}reach private networks (${why})${except}; link-local and cloud metadata addresses are always blocked`;
}

interface Compiled { privateAllowed: boolean; hosts: Set<string>; suffixes: string[]; ranges: Range[] }

function compile(policy: EgressPolicy): Compiled {
  const entries = policy.allow.map(allowEntry);
  const named = entries.filter((e) => !parseRange(e));
  return {
    privateAllowed: policy.privateNetworks === 'allow',
    hosts: new Set(named.filter((e) => !e.startsWith('*.'))),
    suffixes: named.filter((e) => e.startsWith('*.')).map((e) => e.slice(1)),
    ranges: entries.map(parseRange).filter((r): r is Range => r !== undefined),
  };
}

/** Why a connection to `address` (for `hostname`) must not be made, or undefined when it may. */
function refusal(policy: Compiled, hostname: string, address: string): 'always' | 'private' | undefined {
  const ip = parseIp(address);
  const kind = ip ? classify(ip) : 'blocked';
  if (kind === 'blocked' || !ip) return 'always';
  if (kind === 'public' || policy.privateAllowed) return undefined;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (policy.hosts.has(host) || policy.suffixes.some((s) => host.endsWith(s))) return undefined;
  const v4 = asIPv4(ip);
  if (policy.ranges.some((r) => inRange(ip, r) || (v4 !== undefined && inRange(v4, r)))) return undefined;
  return 'private';
}

function blocked(hostname: string, why: 'always' | 'private'): EngineError {
  const host = hostname.length > 120 ? `${hostname.slice(0, 120)}…` : hostname;
  return new EngineError('FORBIDDEN', why === 'always'
    ? `Blocked request to ${host}: link-local, cloud metadata, multicast and reserved addresses are never reachable from flows. JASMINE_PRIVATE_EGRESS and JASMINE_EGRESS_ALLOW do not change this.`
    : `Blocked request to ${host}: the address is on a private network, which flows on this runtime may not reach. Set JASMINE_PRIVATE_EGRESS=allow, or add the host or its CIDR range to JASMINE_EGRESS_ALLOW.`,
  { retryable: false, details: { egress: why } });
}

/* ---------------- fetch ---------------- */

export interface GuardedFetchOptions {
  policy: EgressPolicy;
  /** Every address of a hostname. Defaults to the system resolver, as Node's own connections use. */
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** Fails a request whose connection is idle this long (default 300 s, like fetch's header and body timeouts). */
  timeoutMs?: number;
}

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
/** Ports fetch refuses, so a flow cannot speak HTTP to mail, SSH or similar services. */
const BAD_PORTS = new Set([0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const LENIENT = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
const LENIENT_BROTLI = { flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH };

/** fetch's own failure shape, so callers that report `fetch failed` keep doing so. */
const failed = (reason: string, cause?: unknown) => new TypeError('fetch failed', { cause: cause ?? new Error(reason) });

/**
 * A drop-in `fetch` that applies an egress policy to every connection it makes, including each redirect.
 * Built on node:http so the check can sit in the connection's own lookup; request bodies, decompression,
 * redirects, abort signals and Response objects behave as they do with fetch.
 */
export function guardedFetch(options: GuardedFetchOptions): typeof fetch {
  const policy = compile(options.policy);
  const resolve = options.resolve ?? ((hostname: string) => dns.promises.lookup(hostname, { all: true }));
  const timeoutMs = options.timeoutMs ?? 300_000;
  const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };

  // Runs inside socket.connect: the addresses returned here, all checked, are the ones connected to.
  const lookup: net.LookupFunction = (hostname, lookupOptions, callback) => {
    const family = lookupOptions.family === 'IPv4' ? 4 : lookupOptions.family === 'IPv6' ? 6 : lookupOptions.family ?? 0;
    resolve(hostname).then((found) => {
      for (const { address } of found) {
        const why = refusal(policy, hostname, address);
        if (why) throw blocked(hostname, why);
      }
      const usable = found.filter((a) => !family || a.family === family);
      if (!usable.length) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname });
      if (lookupOptions.all) callback(null, usable);
      else callback(null, usable[0]!.address, usable[0]!.family);
    }).catch((error: NodeJS.ErrnoException) => callback(error, ''));
  };

  const send = (url: URL, method: string, headers: Headers, body: Buffer | undefined, signal: AbortSignal) => new Promise<http.IncomingMessage>((resolve, reject) => {
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
    if (METADATA_HOSTS.has(hostname.replace(/\.$/, ''))) throw blocked(hostname, 'always');
    if (url.port && BAD_PORTS.has(Number(url.port))) throw failed('bad port');
    // An IP literal connects without a lookup, so it is checked here.
    if (net.isIP(hostname)) {
      const why = refusal(policy, hostname, hostname);
      if (why) throw blocked(hostname, why);
    }
    const outgoing: Record<string, string> = {};
    for (const [name, value] of headers) outgoing[name] = value;
    for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length']) delete outgoing[name];
    // The headers fetch adds when they are missing.
    outgoing['accept'] ??= '*/*';
    outgoing['accept-language'] ??= '*';
    outgoing['sec-fetch-mode'] ??= 'cors';
    outgoing['user-agent'] ??= 'node';
    outgoing['accept-encoding'] ??= url.protocol === 'https:' ? 'br, gzip, deflate' : 'gzip, deflate';
    if (body) outgoing['content-length'] = String(body.length);
    else if (method === 'POST' || method === 'PUT') outgoing['content-length'] = '0';
    const secure = url.protocol === 'https:';
    let req: http.ClientRequest;
    try {
      req = (secure ? https : http).request({
        hostname, port: url.port || (secure ? 443 : 80), path: `${url.pathname}${url.search}`, method, headers: outgoing,
        agent: secure ? agents.https : agents.http, lookup,
      });
    } catch (e) {
      // Header characters Headers accepts but Node's HTTP client does not.
      throw failed((e as Error).message, e);
    }
    let response: http.IncomingMessage | undefined;
    const onAbort = () => (response ?? req).destroy(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response activity for ${timeoutMs} ms`)));
    req.on('error', (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.aborted ? signal.reason : error instanceof EngineError ? error : failed(error.message, error));
    });
    req.once('response', (res) => {
      response = res;
      res.once('close', () => signal.removeEventListener('abort', onAbort));
      resolve(res);
    });
    req.end(body);
  });

  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Request normalizes every body type, header form and input shape exactly as fetch would.
    const request = new Request(input, init);
    const signal = request.signal;
    signal.throwIfAborted();
    let url = new URL(request.url);
    // data: and blob: URLs never leave the process.
    if (url.protocol === 'data:' || url.protocol === 'blob:') return fetch(request);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw failed('unknown scheme');
    let method = request.method;
    const headers = new Headers(request.headers);
    let body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    for (let redirects = 0; ; redirects++) {
      const res = await send(url, method, headers, body, signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (!REDIRECT_STATUSES.has(status) || location === undefined || request.redirect === 'manual') return toResponse(res, url, redirects > 0, method);
      res.on('error', () => {});
      res.destroy();
      if (request.redirect === 'error') throw failed('unexpected redirect');
      if (redirects >= MAX_REDIRECTS) throw failed('redirect count exceeded');
      let next: URL;
      try {
        next = new URL(location, url);
      } catch (e) {
        throw failed('invalid redirect location', e);
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw failed('URL scheme must be a HTTP(S) scheme');
      // Method and body rewriting from the fetch standard's HTTP-redirect fetch.
      if (((status === 301 || status === 302) && method === 'POST') || (status === 303 && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
        for (const name of ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length']) headers.delete(name);
      }
      // Credentials stay with the origin they were sent to.
      if (next.origin !== url.origin) for (const name of ['authorization', 'proxy-authorization', 'cookie', 'host']) headers.delete(name);
      if (!next.hash && url.hash) next.hash = url.hash;
      url = next;
    }
  };
  return guarded as typeof fetch;
}

function toResponse(res: http.IncomingMessage, url: URL, redirected: boolean, method: string): Response {
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 599) {
    res.destroy();
    throw failed(`invalid status ${status}`);
  }
  const headers = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    try {
      headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
    } catch {
      /* a header Headers rejects; fetch drops it too */
    }
  }
  let body: ReadableStream<Uint8Array> | null = null;
  if (method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
    res.on('error', () => {});
    res.resume();
  } else {
    body = Readable.toWeb(decoded(res, headers.get('content-encoding'))) as ReadableStream<Uint8Array>;
  }
  let response: Response;
  try {
    response = new Response(body, { status, statusText: res.statusMessage ?? '', headers });
  } catch {
    // A reason phrase fetch would not accept; the status code is what matters.
    response = new Response(body, { status, headers });
  }
  const final = new URL(url);
  final.hash = '';
  Object.defineProperties(response, { url: { value: final.href }, redirected: { value: redirected } });
  return response;
}

/** Undoes Content-Encoding as fetch does: gzip, deflate (zlib or raw), br and zstd. Any other coding leaves the body as sent. */
function decoded(res: http.IncomingMessage, encoding: string | null): Readable {
  const codings = (encoding ?? '').toLowerCase().split(',').map((c) => c.trim()).filter(Boolean);
  if (codings.length > 5) {
    res.destroy();
    throw failed('too many content-encodings');
  }
  const decoders: Transform[] = [];
  for (const coding of codings.reverse()) {
    if (coding === 'gzip' || coding === 'x-gzip') decoders.push(zlib.createGunzip(LENIENT));
    else if (coding === 'deflate') decoders.push(new Inflate());
    else if (coding === 'br') decoders.push(zlib.createBrotliDecompress(LENIENT_BROTLI));
    else if (coding === 'zstd' && typeof zlib.createZstdDecompress === 'function') decoders.push(zlib.createZstdDecompress());
    else return res;
  }
  return decoders.length ? pipeline([res, ...decoders], () => {}) as unknown as Readable : res;
}

/** Deflate arrives zlib-wrapped (RFC 1950) or raw (RFC 1951); like fetch, the first byte tells which. */
class Inflate extends Transform {
  private inner: zlib.Inflate | zlib.InflateRaw | undefined;

  override _transform(chunk: Buffer, encoding: BufferEncoding, done: TransformCallback): void {
    if (!this.inner) {
      if (!chunk.length) {
        done();
        return;
      }
      this.inner = (chunk[0]! & 0x0f) === 0x08 ? zlib.createInflate(LENIENT) : zlib.createInflateRaw(LENIENT);
      this.inner.on('data', (data: Buffer) => this.push(data));
      this.inner.on('end', () => this.push(null));
      this.inner.on('error', (error) => this.destroy(error));
    }
    this.inner.write(chunk, encoding, done);
  }

  override _final(done: TransformCallback): void {
    if (this.inner) this.inner.end();
    else this.push(null);
    done();
  }
}
