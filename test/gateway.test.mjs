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
  it('refuses a secret pasted with a line break or spaces, naming the setting without echoing the value', async () => {
    const transport = vi.fn();
    const pasted = [`${'a'.repeat(64)}\nJASMINE_GATEWAY_SECRET=${'b'.repeat(64)}`, `${'a'.repeat(40)} `, ` ${'a'.repeat(40)}`];
    for (const secret of pasted) {
      const result = await gateway(request('/api/status'), { ...env, JASMINE_GATEWAY_SECRET: secret }, transport);
      expect(result.status).toBe(503);
      const text = await result.text();
      expect(text).toContain('JASMINE_GATEWAY_SECRET in the Vercel environment settings must be a single line');
      expect(text).not.toContain('aaaa');
    }
    const project = await gateway(request('/api/status'), { ...env, JASMINE_PROJECT_ID: 'local\nother' }, transport);
    expect(project.status).toBe(503);
    expect(await project.text()).toContain('JASMINE_PROJECT_ID');
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
  it('shows a person opening a hosted page a page that checks again by itself while the runtime is away', async () => {
    const browser = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
    const away = async () => { throw new TypeError('fetch failed: secret backend details'); };
    const page = await gateway(request('/apps/chat/jasmine-demo', { headers: browser }), env, away);
    expect(page.status).toBe(503);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('retry-after')).toBe('30');
    const html = await page.text();
    expect(html).toContain('This assistant is resting.');
    expect(html).toContain('opens the chat as soon as it answers');
    expect(html).not.toContain('secret backend details');
    expect(html).not.toContain('Vercel environment settings');
    // Its own style and script run under a fresh nonce, and it loads nothing from anywhere.
    const csp = page.headers.get('content-security-policy');
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
    expect(csp).toContain("default-src 'none'");
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).not.toMatch(/\s(?:src|href)="(?!")/);
    const again = await gateway(request('/apps/chat/jasmine-demo', { headers: browser }), env, away);
    expect(again.headers.get('content-security-policy')).not.toContain(nonce);

    // A tunnel answering for a switched-off machine (an empty 502), a slow machine, and a search page.
    const tunnel = await gateway(request('/apps/chat/jasmine-demo?embed=1', { headers: browser }), env, async () => new Response(null, { status: 502 }));
    expect(tunnel.status).toBe(503);
    expect(await tunnel.text()).toContain('This assistant is resting.');
    const slow = await gateway(request('/apps/chat/jasmine-demo', { headers: browser }), env, async () => { throw new DOMException('timed out', 'TimeoutError'); });
    expect(slow.status).toBe(504);
    expect(await slow.text()).toContain('This assistant didn’t answer in time.');
    const search = await gateway(request('/apps/search/docs', { headers: browser }), env, async () => new Response('gateway timeout', { status: 504 }));
    expect(search.status).toBe(504);
    expect(await search.text()).toContain('This search didn’t answer in time.');
    // The page's own check: a HEAD request, answered the same way while the runtime is still away.
    expect((await gateway(request('/apps/chat/jasmine-demo', { method: 'HEAD', headers: { accept: 'text/html' } }), env, away)).status).toBe(503);

    const transport = vi.fn();
    const unconfigured = await gateway(request('/apps/chat/jasmine-demo', { headers: browser }), { ...env, JASMINE_RUNTIME_URL: undefined }, transport);
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.text()).toContain('This assistant isn’t connected yet.');
    expect(transport).not.toHaveBeenCalled();
  });
  it('keeps JSON errors for programs, and passes the runtime\'s own pages through untouched', async () => {
    const away = async () => { throw new TypeError('fetch failed'); };
    const program = await gateway(request('/apps/chat/jasmine-demo'), env, away);
    expect(program.status).toBe(502);
    expect((await program.json()).errors[0].extensions.code).toBe('RUNTIME_UNAVAILABLE');
    const api = await gateway(request('/api/chat/jasmine-demo/config', { headers: { accept: 'text/html' } }), env, away);
    expect(api.headers.get('content-type')).toContain('application/json');
    const post = await gateway(request('/apps/chat/jasmine-demo', { method: 'POST', body: '{}', headers: { accept: 'text/html' } }), env, away);
    expect(post.headers.get('content-type')).toContain('application/json');

    const live = await gateway(request('/apps/chat/jasmine-demo', { headers: { accept: 'text/html' } }), env, async () => new Response('<!doctype html><title>Jasmine</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    expect(live.status).toBe(200);
    expect(await live.text()).toBe('<!doctype html><title>Jasmine</title>');
    const missing = await gateway(request('/apps/chat/nope', { headers: { accept: 'text/html' } }), env, async () => new Response('<p>not here</p>', { status: 404, headers: { 'content-type': 'text/html' } }));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('<p>not here</p>');
  });
  it('does not pass unrelated upstream cookies or leak errors to the browser', async () => {
    const result = await gateway(request('/api/status'), env, async () => new Response('{}', { headers: { 'set-cookie': 'other=secret' } }));
    expect(result.headers.get('set-cookie')).toBeNull();
    const failed = await gateway(request('/api/status'), env, async () => { throw new Error('secret backend details'); });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('secret backend details');
  });
});
