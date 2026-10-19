import { describe, expect, it, vi } from 'vitest';
import { gateway } from '../hosting/gateway.mjs';

const env = { JASMINE_RUNTIME_URL: 'https://runtime.example', JASMINE_GATEWAY_SECRET: 'g'.repeat(40) };
const request = (path, init) => new Request(`https://studio.example${path}`, init);

describe('Vercel gateway', () => {
  it('fails closed before contacting an unconfigured, insecure or self-referencing runtime', async () => {
    const transport = vi.fn();
    for (const runtime of [undefined, 'http://runtime.example', 'https://studio.example', 'https://user:secret@runtime.example', 'https://runtime.example/path']) {
      const result = await gateway(request('/api/status'), { ...env, JASMINE_RUNTIME_URL: runtime }, transport);
      expect(result.status).toBe(503);
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it('preserves the route, query, status, binary body, session and scoped API key without injecting admin access', async () => {
    const transport = vi.fn(async (url, init) => {
      expect(url.href).toBe('https://runtime.example/api/files?mode=raw');
      expect(init.headers.get('x-jasmine-gateway')).toBe(env.JASMINE_GATEWAY_SECRET);
      expect(init.headers.get('authorization')).toBe('Bearer execute-only');
      expect(init.headers.get('cookie')).toBe('jasmine_session=token');
      expect(init.headers.get('x-forwarded-host')).toBeNull();
      expect(init.headers.get('host')).toBeNull();
      expect([...init.body]).toEqual([0, 255, 33]);
      return Response.json({ ok: true }, { status: 201, headers: { 'set-cookie': 'jasmine_session=new; Path=/; HttpOnly; Secure; SameSite=Strict' } });
    });
    const result = await gateway(request('/api/files?mode=raw', { method: 'POST', body: new Uint8Array([0, 255, 33]), headers: {
      authorization: 'Bearer execute-only', 'x-jasmine-gateway': 'attacker', cookie: 'tracking=bad; jasmine_session=token', host: 'bad.example', 'x-forwarded-host': 'bad.example',
    } }), env, transport);
    expect(result.status).toBe(201);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('set-cookie')).toContain('jasmine_session=new');
    expect(await result.json()).toEqual({ ok: true });
  });
  it('names the client for rate limits from Vercel\'s own headers, never from the caller', async () => {
    const seen = [];
    const transport = async (url, init) => { seen.push(init.headers.get('x-jasmine-client-ip')); return Response.json({}); };
    await gateway(request('/api/status', { headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 10.0.0.1', 'x-jasmine-client-ip': '192.0.2.99' } }), env, transport);
    await gateway(request('/api/status', { headers: { 'x-forwarded-for': ' 198.51.100.1 , 10.0.0.1' } }), env, transport);
    await gateway(request('/api/status', { headers: { 'x-jasmine-client-ip': '192.0.2.99' } }), env, transport);
    expect(seen).toEqual(['203.0.113.7', '198.51.100.1', null]);
  });
  it('streams data as it arrives instead of buffering a whole run', async () => {
    let stream;
    const result = await gateway(request('/api/runs/id/events'), env, async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'text/event-stream' } }));
    const reader = result.body.getReader();
    stream.enqueue(new TextEncoder().encode('event: node.token\ndata: "hello"\n\n'));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('hello');
    stream.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n')); stream.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('done');
  });
  it('rejects redirects, unknown routes, missing secrets and oversized uploads', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }));
    expect((await gateway(request('/api/status'), env, transport)).status).toBe(502);
    expect(transport.mock.calls[0][1].redirect).toBe('manual');
    transport.mockClear();
    expect((await gateway(request('/not-an-endpoint'), env, transport)).status).toBe(404);
    expect((await gateway(request('/api/status'), { ...env, JASMINE_GATEWAY_SECRET: '' }, transport)).status).toBe(503);
    expect((await gateway(request('/api/files', { method: 'POST', body: new Uint8Array(4 * 1024 * 1024 + 1) }), env, transport)).status).toBe(413);
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not pass unrelated upstream cookies or leak errors to the browser', async () => {
    const result = await gateway(request('/api/status'), env, async () => new Response('{}', { headers: { 'set-cookie': 'other=secret' } }));
    expect(result.headers.get('set-cookie')).toBeNull();
    const failed = await gateway(request('/api/status'), env, async () => { throw new Error('secret backend details'); });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('secret backend details');
  });
});
