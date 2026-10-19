import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { EngineError } from '../src/errors.ts';
import { classifyAddress, describeEgressPolicy, egressPolicyFromEnv, guardedFetch, type EgressPolicy } from '../src/integrations/egress.ts';

const allowPrivate: EgressPolicy = { privateNetworks: 'allow', allow: [] };
const denyPrivate: EgressPolicy = { privateNetworks: 'deny', allow: [] };

/** A resolver answering from a fixed table, recording each lookup. */
function resolver(table: Record<string, string[]>) {
  const calls: string[] = [];
  const resolve = async (hostname: string) => {
    calls.push(hostname);
    const found = table[hostname];
    if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return Object.assign(resolve, { calls });
}
const noDns = resolver({});

async function expectBlocked(request: Promise<unknown>): Promise<EngineError> {
  const error = await request.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(EngineError);
  expect(error).toMatchObject({ code: 'FORBIDDEN', retryable: false });
  const message = (error as Error).message;
  expect(message).toMatch(/blocked/i);
  expect(message).toContain('JASMINE_PRIVATE_EGRESS');
  expect(message).toContain('JASMINE_EGRESS_ALLOW');
  return error as EngineError;
}

interface Fixture { base: string; port: number; hits: string[]; release: () => void }

/** A loopback server with the routes these tests need. `hits` lists every path that reached it. */
async function withServer(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const hits: string[] = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    hits.push(url.pathname);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      switch (url.pathname) {
        case '/title': res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>Internal admin</title></head><body><main><p>Secret dashboard</p></main></body></html>'); return;
        case '/redirect': res.writeHead(Number(url.searchParams.get('status') ?? 302), { location: url.searchParams.get('to') ?? '/' }).end('Secret redirect body'); return;
        case '/loop': res.writeHead(302, { location: '/loop' }).end(); return;
        case '/echo': res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, headers: req.headers, body: body.toString() })); return;
        case '/gzip': res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync('compressed with gzip')); return;
        case '/br': res.writeHead(200, { 'content-encoding': 'br' }).end(zlib.brotliCompressSync('compressed with brotli')); return;
        case '/deflate': res.writeHead(200, { 'content-encoding': 'deflate' }).end(zlib.deflateSync('compressed with deflate')); return;
        case '/deflate-raw': res.writeHead(200, { 'content-encoding': 'deflate' }).end(zlib.deflateRawSync('compressed with raw deflate')); return;
        case '/stream': res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first;'); void released.then(() => res.end('second')); return;
        case '/search': res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: [{ title: 'Jasmine', url: 'https://j.example', content: 'Local AI workflows' }] })); return;
        case '/v1/models': res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'local-chat' }] })); return;
        case '/hang': return;
        default: res.writeHead(404).end('missing');
      }
    });
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run({ base: `http://127.0.0.1:${port}`, port, hits, release });
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('egress policy', () => {
  it('allows private networks on a local runtime and denies them once the runtime is hosted', () => {
    expect(egressPolicyFromEnv({})).toMatchObject({ privateNetworks: 'allow', allow: [], origin: 'local' });
    expect(egressPolicyFromEnv({ PUBLIC_URL: 'http://127.0.0.1:8787' }).privateNetworks).toBe('allow');
    expect(egressPolicyFromEnv({ PUBLIC_URL: 'http://localhost:8787/' }).privateNetworks).toBe('allow');
    expect(egressPolicyFromEnv({ PUBLIC_URL: 'http://[::1]:8787' }).privateNetworks).toBe('allow');
    expect(egressPolicyFromEnv({ PUBLIC_URL: 'https://studio.example' })).toMatchObject({ privateNetworks: 'deny', origin: 'hosted' });
    expect(egressPolicyFromEnv({ PUBLIC_URL: 'http://192.168.1.20:8787' }).privateNetworks).toBe('deny');
    expect(egressPolicyFromEnv({ JASMINE_GATEWAY_SECRET: 'g'.repeat(40) }).privateNetworks).toBe('deny');
    expect(egressPolicyFromEnv({ PUBLIC_URL: 'https://studio.example', JASMINE_PRIVATE_EGRESS: 'allow' })).toMatchObject({ privateNetworks: 'allow', origin: 'env' });
    expect(egressPolicyFromEnv({ JASMINE_PRIVATE_EGRESS: 'deny' })).toMatchObject({ privateNetworks: 'deny', origin: 'env' });
    expect(egressPolicyFromEnv({ JASMINE_EGRESS_ALLOW: ' Wiki.Internal., 10.2.0.0/16 ,*.corp.example,fd12::/16,' }).allow).toEqual(['wiki.internal', '10.2.0.0/16', '*.corp.example', 'fd12::/16']);
  });

  it('rejects settings it cannot apply instead of guessing', () => {
    expect(() => egressPolicyFromEnv({ JASMINE_PRIVATE_EGRESS: 'sometimes' })).toThrow(/JASMINE_PRIVATE_EGRESS must be allow or deny/);
    for (const entry of ['10.0.0.0/33', 'http://wiki.internal', 'wiki internal', '*', '300.1.1.1']) {
      expect(() => egressPolicyFromEnv({ JASMINE_EGRESS_ALLOW: entry }), entry).toThrow(/JASMINE_EGRESS_ALLOW/);
    }
  });

  it('describes the effective policy for the startup log', () => {
    expect(describeEgressPolicy(egressPolicyFromEnv({}))).toBe('flows may reach private networks (default for a local runtime); link-local and cloud metadata addresses are always blocked');
    expect(describeEgressPolicy(egressPolicyFromEnv({ PUBLIC_URL: 'https://studio.example', JASMINE_EGRESS_ALLOW: 'wiki.internal,10.2.0.0/16' })))
      .toBe('flows may not reach private networks (default for a hosted runtime) except wiki.internal, 10.2.0.0/16; link-local and cloud metadata addresses are always blocked');
    expect(describeEgressPolicy(egressPolicyFromEnv({ PUBLIC_URL: 'https://studio.example', JASMINE_PRIVATE_EGRESS: 'allow' })))
      .toBe('flows may reach private networks (JASMINE_PRIVATE_EGRESS); link-local and cloud metadata addresses are always blocked');
  });

  it('classifies addresses, including IPv4 embedded in IPv6', () => {
    for (const a of ['169.254.169.254', '0.0.0.0', '0.1.2.3', '100.100.100.200', '224.0.0.251', '239.255.255.250', '255.255.255.255', '240.0.0.1', '::', 'fe80::1', 'febf::1', 'fd00:ec2::254', 'ff02::1',
      '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::169.254.169.254', '64:ff9b:1::a9fe:a9fe', '2002:a9fe:a9fe::1', '::ffff:0:a9fe:a9fe', '::169.254.169.254', 'fe80::1%eth0']) {
      expect(classifyAddress(a), a).toBe('blocked');
    }
    for (const a of ['127.0.0.1', '127.255.0.9', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255', '::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '64:ff9b::10.0.0.1', '2002:c0a8:0101::1']) {
      expect(classifyAddress(a), a).toBe('private');
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '169.255.0.1', '93.184.215.14', '2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
      expect(classifyAddress(a), a).toBe('public');
    }
    // Anything that does not parse as an address is treated as blocked.
    for (const a of ['', 'fec0::1x', '1.2.3', 'localhost']) expect(classifyAddress(a), a).toBe('blocked');
  });
});

describe('guarded fetch', () => {
  it('always blocks cloud metadata and link-local addresses, even when private networks and the address are allowed', async () => {
    const fetch = guardedFetch({ policy: { privateNetworks: 'allow', allow: ['169.254.0.0/16', 'metadata.google.internal', 'fd00::/8'] }, resolve: noDns });
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/computeMetadata/v1/', 'http://metadata/computeMetadata/v1/', 'http://100.100.100.200/latest/meta-data/',
      'http://[fd00:ec2::254]/latest/meta-data/', 'http://[fe80::1]/', 'http://0.0.0.0:8787/', 'http://0/', 'http://224.0.0.1/', 'http://255.255.255.255/', 'http://2852039166/']) {
      await expectBlocked(fetch(url));
    }
    expect(noDns.calls).toEqual([]);
  });

  it('blocks IPv4-mapped, translated and NAT64 forms of blocked and private addresses', async () => {
    await withServer(async ({ port, hits }) => {
      const allow = guardedFetch({ policy: allowPrivate, resolve: noDns });
      for (const host of ['[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '[64:ff9b::a9fe:a9fe]', '[2002:a9fe:a9fe::]', '[::ffff:0:a9fe:a9fe]']) await expectBlocked(allow(`http://${host}/latest/meta-data/`));
      const deny = guardedFetch({ policy: denyPrivate, resolve: noDns });
      for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::1]', '[64:ff9b::7f00:1]']) await expectBlocked(deny(`http://${host}:${port}/title`));
      expect(hits).toEqual([]);
    });
  });

  it('reaches private networks only when the policy allows them', async () => {
    await withServer(async ({ base, port, hits }) => {
      const allowed = await guardedFetch({ policy: allowPrivate })(`${base}/title`);
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toContain('Internal admin');
      const deny = guardedFetch({ policy: denyPrivate });
      const error = await expectBlocked(deny(`${base}/title`));
      expect(error.message).not.toContain('Internal admin');
      // The system resolver is used by default; localhost resolves to loopback.
      await expectBlocked(deny(`http://localhost:${port}/title`));
      expect(hits).toEqual(['/title']);
    });
  });

  it('lets JASMINE_EGRESS_ALLOW hostnames and CIDR ranges through when private egress is denied', async () => {
    await withServer(async ({ base, port, hits }) => {
      const dns = resolver({ 'wiki.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'], 'docs.corp.test': ['127.0.0.1'], 'corp.test': ['127.0.0.1'] });
      const byCidr = guardedFetch({ policy: { privateNetworks: 'deny', allow: ['127.0.0.0/8'] }, resolve: dns });
      expect(await (await byCidr(`${base}/title`)).text()).toContain('Internal admin');
      expect((await byCidr(`http://other.test:${port}/title`)).status).toBe(200);
      const byHost = guardedFetch({ policy: { privateNetworks: 'deny', allow: ['wiki.test', '*.corp.test'] }, resolve: dns });
      const wiki = await byHost(`http://wiki.test:${port}/echo`);
      expect((await wiki.json() as { headers: Record<string, string> }).headers['host']).toBe(`wiki.test:${port}`);
      expect((await byHost(`http://docs.corp.test:${port}/title`)).status).toBe(200);
      await expectBlocked(byHost(`http://corp.test:${port}/title`));
      await expectBlocked(byHost(`http://other.test:${port}/title`));
      await expectBlocked(byHost(`${base}/title`));
      expect(hits).toEqual(['/title', '/title', '/echo', '/title']);
    });
  });

  it('checks every address a hostname resolves to, at connection time, with no separate earlier lookup', async () => {
    await withServer(async ({ port, hits }) => {
      const dns = resolver({ 'site.test': ['127.0.0.1'], 'rebind.test': ['10.0.0.7'], 'metadata.test': ['169.254.169.254'], 'mixed.test': ['93.184.215.14', '169.254.169.254'], 'mapped.test': ['::ffff:169.254.169.254'] });
      const allow = guardedFetch({ policy: allowPrivate, resolve: dns });
      for (const host of ['metadata.test', 'mixed.test', 'mapped.test']) await expectBlocked(allow(`http://${host}/`));
      // The connection goes to the address the guarded lookup returned.
      expect(await (await allow(`http://site.test:${port}/title`)).text()).toContain('Internal admin');
      await expectBlocked(guardedFetch({ policy: denyPrivate, resolve: dns })(`http://rebind.test:${port}/title`));
      expect(dns.calls.filter((h) => h === 'rebind.test')).toHaveLength(1);
      expect(hits).toEqual(['/title']);
    });
  });

  it('refuses a redirect from an allowed server to a blocked address', async () => {
    await withServer(async ({ base, hits }) => {
      const allow = guardedFetch({ policy: allowPrivate, resolve: noDns });
      for (const status of [301, 302, 303, 307, 308]) {
        const error = await expectBlocked(allow(`${base}/redirect?status=${status}&to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`));
        expect(error.message).not.toContain('Secret');
      }
      await expectBlocked(allow(`${base}/redirect?to=${encodeURIComponent('http://[::ffff:169.254.169.254]/')}`));
      const firstHopOnly = guardedFetch({ policy: { privateNetworks: 'deny', allow: ['127.0.0.1/32'] }, resolve: noDns });
      await expectBlocked(firstHopOnly(`${base}/redirect?to=${encodeURIComponent('http://10.0.0.1/admin')}`));
      await expectBlocked(firstHopOnly(`${base}/redirect?to=${encodeURIComponent('http://[::1]/admin')}`));
      expect(hits.every((h) => h === '/redirect')).toBe(true);
    });
  });

  it('follows redirects the way fetch does', async () => {
    await withServer(async ({ base, port }) => {
      const dns = resolver({ 'site.test': ['127.0.0.1'] });
      const fetch = guardedFetch({ policy: allowPrivate, resolve: dns });
      const echo = async (res: Response) => ({ status: res.status, url: res.url, redirected: res.redirected, ...await res.json() as { method: string; body: string; headers: Record<string, string> } });
      const to = (status: number, target = '/echo') => `${base}/redirect?status=${status}&to=${encodeURIComponent(target)}`;
      const post = { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain', authorization: 'Bearer secret', cookie: 'a=1' } };
      expect(await echo(await fetch(to(303), post))).toMatchObject({ status: 200, url: `${base}/echo`, redirected: true, method: 'GET', body: '' });
      expect(await echo(await fetch(to(302), post))).toMatchObject({ method: 'GET', body: '' });
      expect(await echo(await fetch(to(301), post))).toMatchObject({ method: 'GET', body: '' });
      const kept = await echo(await fetch(to(307), post));
      expect(kept).toMatchObject({ method: 'POST', body: 'payload' });
      expect(kept.headers).toMatchObject({ 'content-type': 'text/plain', authorization: 'Bearer secret' });
      expect(await echo(await fetch(to(308), { ...post, method: 'PUT' }))).toMatchObject({ method: 'PUT', body: 'payload' });
      // Credentials stay with the origin they were sent to.
      const cross = await echo(await fetch(to(307, `http://site.test:${port}/echo`), post));
      expect(cross).toMatchObject({ url: `http://site.test:${port}/echo`, method: 'POST', body: 'payload' });
      expect(cross.headers['authorization']).toBeUndefined();
      expect(cross.headers['cookie']).toBeUndefined();
      expect(cross.headers['host']).toBe(`site.test:${port}`);
      const manual = await fetch(to(302), { redirect: 'manual' });
      expect([manual.status, manual.headers.get('location'), manual.redirected]).toEqual([302, '/echo', false]);
      await expect(fetch(to(302), { redirect: 'error' })).rejects.toThrow(/fetch failed/);
      await expect(fetch(`${base}/loop`)).rejects.toThrow(/fetch failed/);
      await expect(fetch(to(302, 'ftp://example.com/file'))).rejects.toThrow(/fetch failed/);
    });
  });

  it('decompresses gzip, deflate and brotli bodies and streams responses', async () => {
    await withServer(async ({ base, release }) => {
      const fetch = guardedFetch({ policy: allowPrivate });
      expect(await (await fetch(`${base}/gzip`)).text()).toBe('compressed with gzip');
      expect(await (await fetch(`${base}/br`)).text()).toBe('compressed with brotli');
      expect(await (await fetch(`${base}/deflate`)).text()).toBe('compressed with deflate');
      expect(await (await fetch(`${base}/deflate-raw`)).text()).toBe('compressed with raw deflate');
      const sent = await (await fetch(`${base}/echo`)).json() as { headers: Record<string, string> };
      expect(sent.headers).toMatchObject({ 'accept-encoding': 'gzip, deflate', accept: '*/*', 'user-agent': 'node' });
      const res = await fetch(`${base}/stream`);
      const reader = res.body!.getReader();
      // The first chunk arrives while the server is still holding the response open.
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('first;');
      release();
      let rest = '';
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
      expect(rest).toBe('second');
      const head = await fetch(`${base}/title`, { method: 'HEAD' });
      expect([head.status, head.body]).toEqual([200, null]);
    });
  });

  it('sends request bodies of every kind with the headers fetch would add', async () => {
    await withServer(async ({ base }) => {
      const fetch = guardedFetch({ policy: allowPrivate });
      const sent = async (body: RequestInit['body'], extra: RequestInit = {}) => {
        const res = await fetch(`${base}/echo`, { method: 'POST', body, ...extra });
        const echo = await res.json() as { body: string; headers: Record<string, string> };
        return { body: echo.body, type: echo.headers['content-type'], length: echo.headers['content-length'] };
      };
      expect(await sent('plain text')).toEqual({ body: 'plain text', type: 'text/plain;charset=UTF-8', length: '10' });
      expect(await sent(JSON.stringify({ a: 1 }), { headers: { 'content-type': 'application/json' } })).toEqual({ body: '{"a":1}', type: 'application/json', length: '7' });
      expect(await sent(new URLSearchParams({ q: 'a b' }))).toMatchObject({ body: 'q=a+b', type: 'application/x-www-form-urlencoded;charset=UTF-8' });
      expect(await sent(new TextEncoder().encode('bytes'))).toMatchObject({ body: 'bytes' });
      expect(await sent(new TextEncoder().encode('buffer').buffer as ArrayBuffer)).toMatchObject({ body: 'buffer' });
      expect(await sent(new Blob(['blob'], { type: 'text/x-blob' }))).toMatchObject({ body: 'blob', type: 'text/x-blob' });
      const form = new FormData();
      form.set('field', 'value');
      const multipart = await sent(form);
      expect(multipart.type).toMatch(/^multipart\/form-data; boundary=/);
      expect(multipart.body).toContain('name="field"');
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('str')); c.enqueue(new TextEncoder().encode('eam')); c.close(); } });
      expect(await sent(stream, { duplex: 'half' } as RequestInit)).toMatchObject({ body: 'stream' });
      const request = new Request(`${base}/echo`, { method: 'PUT', body: 'from a Request', headers: { 'x-demo': 'yes' } });
      const echoed = await (await fetch(request)).json() as { method: string; body: string; headers: Record<string, string> };
      expect(echoed).toMatchObject({ method: 'PUT', body: 'from a Request', headers: { 'x-demo': 'yes' } });
    });
  });

  it('honours abort signals while connecting and while reading, and fails idle connections', async () => {
    await withServer(async ({ base }) => {
      const fetch = guardedFetch({ policy: allowPrivate });
      const reason = new Error('Run cancelled');
      await expect(fetch(`${base}/title`, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
      const waiting = new AbortController();
      const pending = fetch(`${base}/hang`, { signal: waiting.signal });
      setTimeout(() => waiting.abort(reason), 50);
      await expect(pending).rejects.toBe(reason);
      const reading = new AbortController();
      const reader = (await fetch(`${base}/stream`, { signal: reading.signal })).body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('first;');
      reading.abort(reason);
      await expect(reader.read()).rejects.toBe(reason);
      await expect(guardedFetch({ policy: allowPrivate, timeoutMs: 100 })(`${base}/hang`)).rejects.toThrow(/fetch failed/);
    });
  });

  it('refuses the ports fetch refuses', async () => {
    const fetch = guardedFetch({ policy: allowPrivate, resolve: noDns });
    for (const port of [1, 22, 25, 6000]) await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/fetch failed/);
  });
});
