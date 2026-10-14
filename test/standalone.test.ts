import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Jasmine } from '../src/app.ts';
import { JasmineClient } from '../sdk/jasmine.mjs';
import { createTestApp, jsonRequest, withHttp } from './helpers.ts';

const echo = (message = '{{t.output.message}}') => ({ nodes: [
  { id: 't', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
  { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: { message } } } },
], edges: [{ source: 't', target: 'r' }] });

describe('standalone API and clients', () => {
  it('executes asynchronously through the SDK, replays live events, pins a version, and honors header idempotency', async () => {
    const t = await createTestApp();
    try {
      const old = await t.app.deployments.deploy('echo', echo('old {{t.output.message}}'));
      await t.app.deployments.deploy('echo', echo('new {{t.output.message}}'));
      await withHttp(t.app, async (base) => {
        const client = new JasmineClient({ endpoint: base });
        const run = await client.executeFlow('echo', { message: 'hello' }, { mode: 'async', idempotencyKey: 'once', version: old.version });
        expect((await client.wait(run.requestId)).output).toEqual({ message: 'old hello' });
        const same = await client.executeFlow('echo', { message: 'hello' }, { idempotencyKey: 'once' });
        expect(same.requestId).toBe(run.requestId);
        await expect(client.executeFlow('echo', { message: 'changed' }, { idempotencyKey: 'once' })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
        const events = []; for await (const event of client.events(run.requestId)) events.push(event);
        expect(events.some((e) => e.event === 'trace' && e.data.type === 'node.success')).toBe(true);
        expect(events.at(-1)?.event).toBe('done');
        expect((await client.trace(run.requestId)).trace.length).toBeGreaterThan(0);
        expect((await client.cancel(run.requestId)).cancelled).toBe(false);
        const request = jsonRequest(base);
        expect((await request('/api/v1/flows/echo/execute', 'POST', { mode: 'typo' })).status).toBe(400);
        expect((await request('/api/v1/flows/echo/execute', 'POST', { idempotencyKey: 123 })).status).toBe(400);
        expect((await request('/api/v1/flows/echo/execute', 'POST', { version: {} })).status).toBe(400);
      });
    } finally { await t.close(); }
  });

  it('keeps run pagination complete when timestamps collide', async () => {
    const t = await createTestApp();
    try {
      for (let i = 0; i < 7; i++) t.app.runStore.start({ id: `run-${i}`, flowId: 'echo', version: 'v', source: 'api', mode: 'async', input: {} });
      t.app.db.run('UPDATE runs SET started_at=?', '2026-10-14T10:00:00.000Z');
      const seen: string[] = []; let cursor: string | null = null;
      do {
        const page = t.app.runStore.list({ limit: 2, ...(cursor ? { before: cursor } : {}) });
        seen.push(...page.runs.map((r) => r.id)); cursor = page.nextBefore;
      } while (cursor);
      expect(new Set(seen).size).toBe(7); expect(seen).toHaveLength(7);
    } finally { await t.close(); }
  });

  it('creates deterministic alerts through HTTP and survives a database restart', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'jasmine-durable-'));
    const config = { dataDir, env: { LLM_PROVIDER: 'mock' }, probeModels: false, scheduler: false, seed: false };
    let app = await Jasmine.create(config);
    try {
      await app.deployments.deploy('echo', echo());
      await withHttp(app, async (base) => {
        const request = jsonRequest(base);
        const rule = await request('/api/alerts/rules', 'POST', { name: 'Failures', kind: 'failure' });
        expect(rule.status).toBe(201);
        const run = await app.runs.executeWorkflow('echo', {});
        const first = (await request('/api/alerts')).data;
        expect(first.events).toHaveLength(1);
        expect(first.events[0].runId).toBe(run.requestId);
        const stored = app.runStore.get(run.requestId)!;
        expect(stored.status).toBe('failed');
        expect((await request(`/api/alerts/${first.events[0].id}/acknowledge`, 'POST', {})).data.acknowledged).toBe(true);
        expect((await request('/api/alerts/rules', 'POST', { name: 'Bad', kind: 'latency', threshold: -1 })).status).toBe(400);
      });
      await app.close(); app = await Jasmine.create(config);
      expect(app.alerts.rules()).toHaveLength(1);
      expect(app.alerts.list()).toHaveLength(1);
      expect(app.alerts.list()[0]?.acknowledgedAt).toBeTruthy();
      expect(app.deployments.getActive('echo')).toBeTruthy();
    } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
  });
});
