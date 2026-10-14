import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { checkQueryComplexity, createApi } from '../src/api/graphql.ts';
import { clientKey, RateLimiter } from '../src/api/http.ts';
import { createServer, hostChecker, ipFilter, isLoopbackAddress, parseIpAllowlist } from '../src/api/server.ts';
import { getIntrospectionQuery, parse } from 'graphql';
import { createTestApp, withHttp } from './helpers.ts';

/** node:http request, so tests can send the Host and Origin headers a browser would. */
function raw(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const u = new URL(base);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: () => any }>((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method: opts.method ?? 'GET', headers: opts.headers ?? {} }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

const json = { 'content-type': 'application/json' };
const port = (base: string) => new URL(base).port;

describe('keyless server: DNS rebinding and cross-site requests', () => {
  it('answers keyless admin requests only for loopback and configured host names', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        const p = port(base);
        for (const host of [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`, `studio.localhost:${p}`, `jasmine.lan:${p}`]) {
          expect((await raw(base, '/api/settings', { headers: { host } })).status, host).toBe(200);
        }
        const rebound = await raw(base, '/api/settings', { headers: { host: `attacker.example:${p}`, origin: `http://attacker.example:${p}` } });
        expect(rebound.status).toBe(403);
        expect(rebound.json().errors[0].message).toMatch(/JASMINE_API_KEY.*JASMINE_ALLOWED_HOSTS/);
        expect((await raw(base, '/api/v1/runs/x', { headers: { host: `attacker.example:${p}` } })).status).toBe(403);
        // Public routes and keyed requests are not restricted by Host.
        expect((await raw(base, '/api/status', { headers: { host: `attacker.example:${p}` } })).status).toBe(200);
        const { token } = t.app.apiKeys.create('admin', 'admin');
        expect((await raw(base, '/api/settings', { headers: { host: `jasmine.example.com:${p}`, authorization: `Bearer ${token}` } })).status).toBe(200);
      }, { allowedHosts: ['jasmine.lan'] });
    } finally {
      await t.close();
    }
  });

  it('accepts PUBLIC_URL as a host and as the browser origin behind a Host-rewriting proxy', async () => {
    const t = await createTestApp({ env: { LLM_PROVIDER: 'mock', PUBLIC_URL: 'https://jasmine.example.com' } });
    try {
      await withHttp(t.app, async (base) => {
        expect((await raw(base, '/api/settings', { headers: { host: 'jasmine.example.com' } })).status).toBe(200);
        const viaProxy = await raw(base, '/api/flows', { method: 'POST', headers: { ...json, origin: 'https://jasmine.example.com' }, body: '{"name":"proxied"}' });
        expect(viaProxy.status).toBe(201);
      });
    } finally {
      await t.close();
    }
  });

  it('rejects cross-origin state changes and text/plain bodies, without breaking same-origin, SDK, upload or widget calls', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        const evil = { origin: 'https://evil.example' };
        // The reported attack: simple (no preflight) text/plain posts from another site.
        const csrf = await raw(base, '/api/keys', { method: 'POST', headers: { ...evil, 'content-type': 'text/plain' }, body: '{"name":"pwn","scope":"admin"}' });
        expect(csrf.status).toBe(403);
        expect(csrf.json().errors[0].message).toMatch(/Cross-origin/);
        expect((await raw(base, '/api/keys', { method: 'POST', headers: { ...evil, ...json }, body: '{"name":"pwn"}' })).status).toBe(403);
        expect((await raw(base, '/api/models/connections/builtin/test', { method: 'POST', headers: { origin: 'null' } })).status).toBe(403);
        expect(t.app.apiKeys.list()).toEqual([]);
        // Without an Origin, a JSON API refuses non-JSON bodies.
        const plain = await raw(base, '/api/flows', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"name":"x"}' });
        expect(plain.status).toBe(400);
        expect(plain.json().errors[0].message).toBe('Content-Type must be application/json');
        // Same-origin Studio requests and Origin-less SDK requests work.
        expect((await raw(base, '/api/flows', { method: 'POST', headers: { ...json, origin: base }, body: '{"name":"studio"}' })).status).toBe(201);
        expect((await raw(base, '/api/flows', { method: 'POST', headers: { 'content-type': 'application/vnd.api+json; charset=utf-8' }, body: '{"name":"sdk"}' })).status).toBe(201);
        expect((await fetch(`${base}/api/files`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-filename': 'a.txt' }, body: 'hello' })).status).toBe(201);
        // A cross-origin GET still cannot read: no CORS headers on admin responses.
        const read = await raw(base, '/api/settings', { headers: evil });
        expect(read.headers['access-control-allow-origin']).toBeUndefined();
        // Even with a valid key, browsers on other sites cannot change state.
        const { token } = t.app.apiKeys.create('admin', 'admin');
        expect((await raw(base, '/api/flows', { method: 'POST', headers: { ...evil, ...json, authorization: `Bearer ${token}` }, body: '{"name":"x"}' })).status).toBe(403);
      });
    } finally {
      await t.close();
    }
  });

  it('only answers CORS preflights for public routes', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        const pre = (path: string, method = 'POST') => raw(base, path, { method: 'OPTIONS', headers: { origin: 'https://site.example', 'access-control-request-method': method, 'access-control-request-headers': 'content-type' } });
        for (const path of ['/api/keys', '/graphql', '/api/v1/flows/x/execute', '/mcp', '/api/settings/secrets/X']) {
          const res = await pre(path, path.includes('secrets') ? 'PUT' : 'POST');
          expect(res.status).toBe(204);
          expect(res.headers['access-control-allow-origin'], path).toBeUndefined();
        }
        for (const path of ['/api/chat/flow', '/api/search/flow', '/webhooks/flow']) {
          expect((await pre(path)).headers['access-control-allow-origin'], path).toBe('https://site.example');
        }
        expect((await pre('/api/chat/flow/config', 'GET')).headers['access-control-allow-origin']).toBe('https://site.example');
      });
    } finally {
      await t.close();
    }
  });
});

describe('model connections', () => {
  it('clears a stored API key when the base URL changes without a new key', async () => {
    const t = await createTestApp();
    try {
      const c = t.app.connections;
      c.upsert({ id: 'cloud', name: 'Cloud', kind: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret-value' });
      expect(c.upsert({ id: 'cloud', name: 'Renamed', kind: 'openai', baseUrl: 'https://api.example.com/v1' }).hasApiKey).toBe(true);
      expect(c.upsert({ id: 'cloud', name: 'Renamed', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1' }).hasApiKey).toBe(false);
      expect(c.upsert({ id: 'cloud', name: 'Renamed', kind: 'openai', baseUrl: 'https://api.example.com/v1' }).hasApiKey).toBe(false);
      expect(c.upsert({ id: 'cloud', name: 'Moved', kind: 'openai', baseUrl: 'https://other.example.com/v1', apiKey: 'sk-new-value' }).hasApiKey).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe('GraphQL limits', () => {
  const HEALTH = 'flowVersions(workflowId:"x"){version}';

  it('rejects documents that would make validation quadratic, quickly', async () => {
    const t = await createTestApp();
    try {
      const api = createApi(t.app.deployments, t.app.runs, t.app.feedback);
      // Before the limits, 1000 repeats (38 KB) blocked the event loop for about 25 s.
      for (const [n, error] of [[1000, /tokens/], [250, /more than 10 times/]] as const) {
        const started = performance.now();
        const res = await api.execute(`{${Array.from({ length: n }, () => HEALTH).join(' ')}}`, undefined, undefined, { scope: 'execute' });
        expect(performance.now() - started).toBeLessThan(1500);
        expect(res.errors?.[0]?.message).toMatch(error);
      }
      expect((await api.execute(`{${Array.from({ length: 10 }, () => HEALTH).join(' ')}}`)).errors).toBeUndefined();
      expect((await api.execute(`{${Array.from({ length: 60 }, (_, i) => `a${i}:${HEALTH}`).join(' ')}}`)).errors).toBeUndefined();
      expect((await api.execute(`{${Array.from({ length: 260 }, (_, i) => `a${i}:${HEALTH}`).join(' ')}}`)).errors?.[0]?.message).toMatch(/more than 500 fields/);
      expect((await api.execute(`{ ${'a{'.repeat(21)}b${'}'.repeat(21)} }`)).errors?.[0]?.message).toMatch(/deeper/);
      // Repeated fields with nested selections multiply the work (7x7x7 nested repeats took about 2.8 s).
      const rep = (n: number, text: string) => Array.from({ length: n }, () => text).join(' ');
      const nested = `{${rep(7, `a(x:1){ ${rep(7, `b(y:1){ ${rep(7, 'c(z:1)')} }`)} }`)}}`;
      const t0 = performance.now();
      expect((await api.execute(nested)).errors?.[0]?.message).toMatch(/too often/);
      expect(performance.now() - t0).toBeLessThan(500);
      // Tooling still works: the full introspection query fits the budget.
      const introspection = getIntrospectionQuery({ descriptions: true, specifiedByUrl: true, directiveIsRepeatable: true, schemaDescription: true, inputValueDeprecation: true });
      expect((await api.execute(introspection)).errors).toBeUndefined();
      expect((await api.execute(`# ${'x'.repeat(70_000)}\n{${HEALTH}}`)).errors?.[0]?.message).toMatch(/exceeds/);
      expect((await api.execute(`{${Array.from({ length: 6000 }, () => 'a').join(' ')}}`)).errors?.[0]?.message).toMatch(/token/i);
      // Fragments are expanded when counting repeats.
      const fragments = `query { ...A ...B } fragment A on Query { ${Array.from({ length: 6 }, () => HEALTH).join(' ')} } fragment B on Query { ${Array.from({ length: 6 }, () => HEALTH).join(' ')} }`;
      expect(checkQueryComplexity(parse(fragments))).toMatch(/more than 10 times/);
    } finally {
      await t.close();
    }
  });

  it('keeps runHistory (every caller\'s inputs and outputs) admin-only', async () => {
    const t = await createTestApp();
    try {
      const api = createApi(t.app.deployments, t.app.runs, t.app.feedback);
      const q = '{ runHistory(workflowId: "x") { requestId } }';
      expect((await api.execute(q, undefined, undefined, { scope: 'execute' })).errors?.[0]?.extensions?.['code']).toBe('FORBIDDEN');
      expect(await api.execute(q, undefined, undefined, { scope: 'admin' })).toEqual({ data: { runHistory: [] } });
    } finally {
      await t.close();
    }
  });
});

describe('IP allowlist', () => {
  it('parses CIDR entries strictly', () => {
    for (const bad of ['10.0.0.0/', '10.0.0.0/abc', '10.0.0.0/33', '10.1.2.3/8/x', '::/129', '10.0.0.0/ 8', '10.0.0.0/-1', 'example.com', '10.0.0.0/0x8']) {
      expect(() => parseIpAllowlist([bad]), bad).toThrow(/Invalid IP allowlist entry/);
    }
    expect(() => parseIpAllowlist(['10.0.0.0/8', '192.168.1.5', '2001:db8::/32', '0.0.0.0/0'])).not.toThrow();
  });

  it('checks the socket address and lets only the loopback health check past it', async () => {
    const allowed = ipFilter(['10.0.0.0/8', '2001:db8::/32']);
    for (const ip of ['10.1.2.3', '::ffff:10.1.2.3', '2001:db8::5']) expect(allowed(ip), ip).toBe(true);
    // Loopback is not exempt: a reverse proxy on the same host would otherwise let every client through.
    for (const ip of ['192.168.0.1', '::ffff:192.168.0.1', '2001:db9::1', '127.0.0.1', '::1', '', undefined]) expect(allowed(ip), String(ip)).toBe(false);
    expect(isLoopbackAddress('::ffff:7f00:1')).toBe(true);
    const t = await createTestApp();
    try {
      expect(() => createServer(t.app, { ipAllowlist: ['10.0.0.0/'] })).toThrow(/prefix/);
      // The container health check connects over loopback.
      await withHttp(t.app, async (base) => {
        expect((await fetch(`${base}/api/status`, { headers: { 'x-forwarded-for': '10.0.0.1' } })).status).toBe(200);
        expect((await fetch(`${base}/api/flows`)).status).toBe(403);
      }, { ipAllowlist: ['172.18.0.0/16'] });
    } finally {
      await t.close();
    }
  });
});

describe('allowed host names', () => {
  it('matches exact names, ports and wildcards', () => {
    const ok = hostChecker(['jasmine.lan', 'box.lan:9000', '*.corp.example']);
    for (const h of ['localhost:8787', '127.0.0.1', '[::1]:8787', 'jasmine.lan:1', 'box.lan:9000', 'a.corp.example', undefined]) expect(ok(h), String(h)).toBe(true);
    for (const h of ['box.lan:9001', 'corp.example', 'evil.com', 'jasmine.lan.evil.com', 'localhost.evil.com', 'a b', '']) expect(ok(h), h).toBe(false);
    expect(hostChecker(['*'])('anything.example')).toBe(true);
    expect(() => hostChecker(['http://x/path'])).toThrow(/Invalid allowed host/);
  });
});

describe('public endpoint rate limiting', () => {
  it('does not reset live counters when many clients appear', () => {
    const limiter = new RateLimiter(60, 60_000);
    for (let i = 0; i < 60; i++) expect(limiter.allow('victim-flood')).toBe(true);
    expect(limiter.allow('victim-flood')).toBe(false);
    for (let i = 0; i < 10_002; i++) limiter.allow(`10.${i >> 8}.${i & 255}.1`);
    expect(limiter.allow('victim-flood')).toBe(false);
  });

  it('evicts expired windows first and stays bounded', () => {
    const limiter = new RateLimiter(1, 1000, 100);
    for (let i = 0; i < 90; i++) limiter.allow(`old-${i}`, 0);
    limiter.allow('live', 5000);
    expect(limiter.allow('live', 5000)).toBe(false);
    for (let i = 0; i < 200; i++) limiter.allow(`new-${i}`, 5000);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it('keys IPv6 clients by /64 and IPv4-mapped addresses as IPv4', () => {
    expect(clientKey('2001:db8:1:2::1')).toBe(clientKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(clientKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:3::1')).not.toBe(clientKey('2001:db8:1:2::1'));
    expect(clientKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey(undefined)).toBe('unknown');
  });
});

describe('server odds and ends', () => {
  it('reports the enforced project id, serves dotted Studio deep links and answers malformed input with 400', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        const status = await (await fetch(`${base}/api/status`)).json() as { requiredProjectId: string | null; project: { id: string } };
        expect(status.requiredProjectId).toBe('proj-1');
        expect(status.project.id).toBe('proj-1');
        expect((await fetch(`${base}/api/settings`, { headers: { 'x-project-id': 'proj-1' } }).then((r) => r.json()) as { project: { id: string } }).project.id).toBe('proj-1');

        const deep = await fetch(`${base}/context/docs.v2`);
        expect(deep.status).toBe(200);
        expect(deep.headers.get('content-type')).toMatch(/text\/html/);
        expect((await fetch(`${base}/flows/my.flow`)).status).toBe(200);
        expect((await fetch(`${base}/js/missing.js`)).status).toBe(404);
        expect((await fetch(`${base}/app.css`)).headers.get('content-type')).toMatch(/text\/css/);

        expect((await raw(base, '/%E0%A4%A')).status).toBe(400);
        const h = { 'x-project-id': 'proj-1' };
        expect((await fetch(`${base}/api/files`, { method: 'POST', headers: { ...h, 'x-filename': '%E0%A4%A' }, body: 'x' })).status).toBe(400);
        expect((await fetch(`${base}/api/flows`, { method: 'POST', headers: { ...h, ...json }, body: '{"name":5}' })).status).toBe(400);
        expect((await fetch(`${base}/api/import`, { method: 'POST', headers: { ...h, ...json }, body: JSON.stringify({ format: 'jasmine-project', version: 1, flows: [{ id: 'x1', name: 5, definition: { nodes: [], edges: [] } }] }) })).status).toBe(400);
        expect((await fetch(`${base}/api/oauth/connect/gmail`, { method: 'POST', headers: { ...h, ...json }, body: '{"name":5}' })).status).toBe(400);
      }, { projectId: 'proj-1' });
      await withHttp(t.app, async (base) => {
        expect((await (await fetch(`${base}/api/status`)).json() as { requiredProjectId: unknown }).requiredProjectId).toBeNull();
      });
    } finally {
      await t.close();
    }
  });

  it('warns when an execute key is created while the Studio has no admin key', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async (base) => {
        const res = await fetch(`${base}/api/keys`, { method: 'POST', headers: json, body: '{"name":"app","scope":"execute"}' });
        expect(res.status).toBe(201);
        expect((await res.json() as { warning?: string }).warning).toMatch(/No admin key/);
      });
    } finally {
      await t.close();
    }
  });
});
