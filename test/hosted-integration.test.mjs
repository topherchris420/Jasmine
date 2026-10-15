import { describe, expect, it } from 'vitest';
import { gateway } from '../hosting/gateway.mjs';
import { createTestApp, withHttp } from './helpers.ts';

const secret = 'gateway-integration-secret'.repeat(2);
const publicOrigin = 'https://studio.example';
const env = { JASMINE_RUNTIME_URL: 'https://runtime.example', JASMINE_GATEWAY_SECRET: secret };

describe('Studio gateway and persistent engine contract', () => {
  it('supports sign-in, flow creation, execution, scoped consumers, and public chat pages through the real HTTP engine', async () => {
    const t = await createTestApp({ env: { LLM_PROVIDER: 'mock', JASMINE_API_KEY: 'owner', JASMINE_GATEWAY_SECRET: secret, PUBLIC_URL: publicOrigin } });
    try {
      await withHttp(t.app, async base => {
        const transport = (url, options) => fetch(`${base}${url.pathname}${url.search}`, options);
        let cookie = '';
        const call = (path, method = 'GET', body, authorization) => gateway(new Request(`${publicOrigin}${path}`, {
          method, headers: { origin: publicOrigin, ...(authorization ? { authorization: `Bearer ${authorization}` } : cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }), env, transport);
        const signedIn = await call('/api/auth/session', 'POST', { apiKey: 'owner' });
        expect(signedIn.status).toBe(200);
        cookie = signedIn.headers.get('set-cookie').split(';')[0];
        const created = await call('/api/flows', 'POST', { templateId: 'first-workflow' });
        expect(created.status).toBe(201);
        const { id } = await created.json();
        expect((await call(`/api/flows/${id}/deploy`, 'POST', {})).status).toBe(200);
        const consumer = t.app.apiKeys.create('Application', 'execute');
        const executed = await call(`/api/v1/flows/${id}/execute`, 'POST', { payload: { message: 'through Vercel' } }, consumer.token);
        expect((await executed.json()).output.message).toBe('through Vercel');
        expect((await call('/api/flows', 'GET', undefined, consumer.token)).status).toBe(403);
        const chatTemplate = (await t.app.templates()).find(template => template.id === 'getting-started');
        await t.app.deployments.deploy('chat', chatTemplate.definition);
        cookie = '';
        const widget = await call('/apps/chat/chat');
        expect(widget.status).toBe(200);
        expect(widget.headers.get('content-type')).toContain('text/html');
        expect(widget.headers.get('content-security-policy')).toContain('frame-ancestors *');
        expect(await widget.text()).toContain('src="/apps/chat.js"');
      });
    } finally { await t.close(); }
  });
});
