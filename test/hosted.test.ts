import { describe, expect, it } from 'vitest';
import { createTestApp, jsonRequest, withHttp } from './helpers.ts';

describe('Hosted workspace sessions', () => {
  it('signs in with an admin key, protects writes by origin, and revokes on logout', async () => {
    const t = await createTestApp({ env: { LLM_PROVIDER: 'mock', JASMINE_API_KEY: 'workspace-admin' } });
    try {
      await withHttp(t.app, async base => {
        const anon = jsonRequest(base);
        expect((await anon('/api/flows')).status).toBe(403);
        const login = await jsonRequest(base, { origin: base })('/api/auth/session', 'POST', { apiKey: 'workspace-admin' });
        expect(login.status).toBe(200);
        const cookie = login.headers.get('set-cookie')!;
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('SameSite=Strict');
        expect(cookie).not.toContain('workspace-admin');
        const session = jsonRequest(base, { cookie });
        expect((await session('/api/flows')).status).toBe(200);
        expect((await session('/api/setup', 'PUT', { name: 'Test workspace' })).status).toBe(403);
        expect((await jsonRequest(base, { cookie, origin: 'https://attacker.example' })('/api/setup', 'PUT', { name: 'Bad' })).status).toBe(403);
        expect((await jsonRequest(base, { cookie, origin: base, 'sec-fetch-site': 'cross-site' })('/api/setup', 'PUT', { name: 'Bad' })).status).toBe(403);
        // With a key configured, the Host check stays off and a forged cross-site write still lacks credentials.
        expect((await fetch(`${base}/api/flows`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'http://evil.example' }, body: '{}' })).status).toBe(403);
        expect((await fetch(`${base}/api/flows`, { method: 'OPTIONS', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } })).status).toBe(403);
        const owner = jsonRequest(base, { cookie, origin: base });
        expect((await owner('/api/setup', 'PUT', { name: 'My workspace', complete: true })).data.project.name).toBe('My workspace');
        expect((await owner('/api/setup')).data.complete).toBe(true);
        expect((await owner('/api/auth/session', 'DELETE')).headers.get('set-cookie')).toContain('Max-Age=0');
        expect((await session('/api/flows')).status).toBe(403);
      });
    } finally { await t.close(); }
  });

  it('rejects execute keys, expired sessions and sessions whose admin key was revoked', async () => {
    const t = await createTestApp();
    try {
      const admin = t.app.apiKeys.create('Owner', 'admin');
      const execute = t.app.apiKeys.create('Consumer', 'execute');
      expect(t.app.sessions.create(execute.token)).toBeUndefined();
      const expired = t.app.sessions.create(admin.token)!;
      t.app.db.run('UPDATE browser_sessions SET expires_at = 0');
      expect(t.app.sessions.verify(expired)).toBe(false);
      const token = t.app.sessions.create(admin.token)!;
      expect(t.app.sessions.verify(token)).toBe(true);
      t.app.apiKeys.revoke(admin.key.id);
      expect(t.app.sessions.verify(token)).toBe(false);
    } finally { await t.close(); }
  });

  it('requires the gateway secret and issues Secure cookies with an HTTPS public URL', async () => {
    const t = await createTestApp({ env: { LLM_PROVIDER: 'mock', JASMINE_API_KEY: 'owner', JASMINE_GATEWAY_SECRET: 'gateway-secret', PUBLIC_URL: 'https://studio.example' } });
    try {
      await withHttp(t.app, async base => {
        expect((await jsonRequest(base)('/healthz')).status).toBe(200);
        expect((await jsonRequest(base)('/api/status')).status).toBe(403);
        const owner = jsonRequest(base, { 'x-jasmine-gateway': 'gateway-secret', origin: 'https://studio.example' });
        expect((await owner('/api/status')).status).toBe(200);
        const login = await owner('/api/auth/session', 'POST', { apiKey: 'owner' });
        expect(login.headers.get('set-cookie')).toContain('; Secure');
        expect((await jsonRequest(base, { 'x-jasmine-gateway': 'gateway-secret', origin: 'https://wrong.example' })('/api/auth/session', 'POST', { apiKey: 'owner' })).status).toBe(403);
      });
    } finally { await t.close(); }
  });

  it('rate-limits each client the gateway names, and trusts that name only with the gateway secret', async () => {
    const hook = {
      nodes: [
        { id: 't', data: { nodeId: 'webhookTriggerNode', trigger: true, values: {} } },
        { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"ok": true}' } } },
      ],
      edges: [{ source: 't', target: 'r' }],
    };
    const gatewayed = await createTestApp({ env: { LLM_PROVIDER: 'mock', JASMINE_API_KEY: 'owner', JASMINE_GATEWAY_SECRET: 'gateway-secret', PUBLIC_URL: 'https://studio.example' } });
    try {
      await gatewayed.app.deployments.deploy('limited-hook', hook);
      await withHttp(gatewayed.app, async base => {
        const from = (ip: string) => jsonRequest(base, { 'x-jasmine-gateway': 'gateway-secret', origin: 'https://studio.example', 'x-jasmine-client-ip': ip });
        for (let i = 0; i < 10; i++) expect((await from('203.0.113.7')('/api/auth/session', 'POST', { apiKey: 'wrong' })).status).toBe(403);
        expect((await from('203.0.113.7')('/api/auth/session', 'POST', { apiKey: 'wrong' })).status).toBe(429);
        expect((await from('203.0.113.8')('/api/auth/session', 'POST', { apiKey: 'owner' })).status).toBe(200);
        for (let i = 0; i < 60; i++) expect((await from('198.51.100.1')('/webhooks/limited-hook', 'POST', {})).status).toBe(200);
        expect((await from('198.51.100.1')('/webhooks/limited-hook', 'POST', {})).status).toBe(429);
        expect((await from('198.51.100.2')('/webhooks/limited-hook', 'POST', {})).status).toBe(200);
      });
    } finally { await gatewayed.close(); }

    // Without a gateway secret anyone could send the header, so limits count the connecting socket.
    const direct = await createTestApp({ env: { LLM_PROVIDER: 'mock', JASMINE_API_KEY: 'owner' } });
    try {
      await withHttp(direct.app, async base => {
        for (let i = 0; i < 10; i++) expect((await jsonRequest(base, { origin: base, 'x-jasmine-client-ip': `203.0.113.${i}` })('/api/auth/session', 'POST', { apiKey: 'wrong' })).status).toBe(403);
        expect((await jsonRequest(base, { origin: base, 'x-jasmine-client-ip': '203.0.113.200' })('/api/auth/session', 'POST', { apiKey: 'owner' })).status).toBe(429);
      });
    } finally { await direct.close(); }
  });

  it('creates, tests and deploys a first API without any model calls', async () => {
    const t = await createTestApp();
    try {
      await withHttp(t.app, async base => {
        const req = jsonRequest(base);
        const flow = await req('/api/flows', 'POST', { templateId: 'first-workflow' });
        expect(flow.status).toBe(201);
        const tested = await req(`/api/flows/${flow.data.id}/test`, 'POST', { payload: { message: 'My first request' } });
        const result = await t.app.runs.wait(tested.data.requestId);
        expect(result.status).toBe('success');
        expect(result.output).toEqual({ message: 'My first request', source: 'Built with Jasmine', ready: true });
        expect(result.usage?.llmCalls).toBe(0);
        expect((await req(`/api/flows/${flow.data.id}/deploy`, 'POST')).status).toBe(200);
        expect((await req(`/api/v1/flows/${flow.data.id}/execute`, 'POST', { payload: { message: 'Deployed' } })).data.output.message).toBe('Deployed');
        expect((await req('/api/hosting')).data.checks.find((c: { id: string }) => c.id === 'storage').state).toBe('blocking');
      });
    } finally { await t.close(); }
  });
});
