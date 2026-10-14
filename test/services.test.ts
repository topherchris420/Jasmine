import { getEventListeners } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../src/flow/schema.ts';
import { DeploymentRegistry } from '../src/service/deployments.ts';
import { RunService } from '../src/service/runs.ts';
import { edge, fakeFetch, makeServices, newLog, probe, response, testRegistry, trigger, type ProbeLog } from './helpers.ts';

const flowDef = (value: string, opts: { delayMs?: number; name?: string; async?: boolean } = {}) => ({
  ...(opts.name ? { name: opts.name } : {}),
  nodes: [trigger(opts.async ? { responeType: 'async' } : {}), probe('a', { value, delayMs: opts.delayMs ?? 0 }), response('{"v":"{{a.output.value}}"}')],
  edges: [edge('trigger', 'a'), edge('a', 'response')],
});

function setup(log: ProbeLog = newLog(), publish?: ConstructorParameters<typeof DeploymentRegistry>[1], runOpts: Partial<ConstructorParameters<typeof RunService>[1]> = {}) {
  const deployments = new DeploymentRegistry(testRegistry(log), publish);
  const runs = new RunService(deployments, { services: makeServices(), ...runOpts });
  return { deployments, runs, log };
}

describe('deployments', () => {
  it('compiles once per content version; redeploying unchanged content is a no-op', async () => {
    const { deployments } = setup();
    const first = await deployments.deploy('f', flowDef('v1'));
    const again = await deployments.deploy('f', flowDef('v1'));
    expect(first.changed).toBe(true);
    expect(again).toMatchObject({ changed: false, version: first.version });
    expect(deployments.stats).toEqual({ compiles: 1, cacheHits: 1 });
  });

  it('keeps the last known-good version when a deploy fails to compile or publish', async () => {
    let failPublish = false;
    const { deployments, runs } = setup(newLog(), async () => {
      if (failPublish) throw new Error('edge upload failed');
    });
    const good = await deployments.deploy('f', flowDef('good'));
    await expect(deployments.deploy('f', { nodes: [probe('a')], edges: [] })).rejects.toMatchObject({ code: 'COMPILE' });
    failPublish = true;
    await expect(deployments.deploy('f', flowDef('new'))).rejects.toMatchObject({ code: 'DEPLOY_FAILED' });
    expect(deployments.getActive('f')?.version).toBe(good.version);
    expect((await runs.executeWorkflow('f', {})).output).toEqual({ v: 'good' });
  });

  it('refuses to let a slower, older deploy overwrite a newer one (no lost update)', async () => {
    const { deployments } = setup(newLog(), (d) => sleep(d.plan.definition.name === 'slow' ? 80 : 5));
    const [slow, fast] = await Promise.allSettled([
      deployments.deploy('f', flowDef('slow', { name: 'slow' })),
      deployments.deploy('f', flowDef('fast', { name: 'fast' })),
    ]);
    expect(fast.status).toBe('fulfilled');
    expect(slow).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } });
    expect(deployments.getActive('f')?.plan.definition.name).toBe('fast');
  });

  it('supports compare-and-swap deploys and instant rollback', async () => {
    const { deployments, runs } = setup();
    const v1 = await deployments.deploy('f', flowDef('one'));
    await expect(deployments.deploy('f', flowDef('two'), { expectedVersion: 'v_stale' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await deployments.deploy('f', flowDef('two'), { expectedVersion: v1.version });
    expect((await runs.executeWorkflow('f', {})).output).toEqual({ v: 'two' });
    const rb = deployments.rollback('f');
    expect(rb.version).toBe(v1.version);
    expect((await runs.executeWorkflow('f', {})).output).toEqual({ v: 'one' });
  });
});

describe('runs', () => {
  it('pins a run to the version it started on, even if a deploy lands mid-run', async () => {
    const { deployments, runs } = setup();
    const v1 = await deployments.deploy('f', flowDef('one', { delayMs: 60 }));
    const inflight = runs.executeWorkflow('f', {});
    await sleep(10);
    await deployments.deploy('f', flowDef('two'));
    const res = await inflight;
    expect(res).toMatchObject({ output: { v: 'one' }, result: { v: 'one' }, version: v1.version });
    expect((await runs.executeWorkflow('f', {})).output).toEqual({ v: 'two' });
  });

  it('deduplicates client retries with an idempotency key', async () => {
    const { deployments, runs, log } = setup();
    await deployments.deploy('f', flowDef('x', { delayMs: 20 }));
    const [a, b] = await Promise.all([
      runs.executeWorkflow('f', { order: 1 }, { idempotencyKey: 'k1' }),
      runs.executeWorkflow('f', { order: 1 }, { idempotencyKey: 'k1' }),
    ]);
    expect(a.requestId).toBe(b.requestId);
    expect(log.calls.get('a')).toBe(1);
    await expect(runs.executeWorkflow('f', { order: 2 }, { idempotencyKey: 'k1' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('serves async flows through requestId + checkStatus', async () => {
    const { deployments, runs } = setup();
    await deployments.deploy('f', flowDef('later', { delayMs: 20, async: true }));
    const started = await runs.executeWorkflow('f', {});
    expect(started.status).toBe('in-progress');
    let status = runs.checkStatus(started.requestId);
    for (let i = 0; i < 100 && status.status === 'in-progress'; i++) {
      await sleep(5);
      status = runs.checkStatus(started.requestId);
    }
    expect(status).toMatchObject({ status: 'success', result: { v: 'later' } });
  });

  it('applies backpressure instead of queueing without bound', async () => {
    const { deployments, runs } = setup(newLog(), undefined, { maxConcurrentRuns: 1, maxQueuedRuns: 1 });
    await deployments.deploy('f', flowDef('x', { delayMs: 50, async: true }));
    await runs.executeWorkflow('f', {});
    await runs.executeWorkflow('f', {});
    await expect(runs.executeWorkflow('f', {})).rejects.toMatchObject({ code: 'OVERLOADED', retryable: true });
  });

  it('retries from the failed node on the original version without repeating completed side effects', async () => {
    let notifyFails = true;
    const http = fakeFetch((url) => (url.includes('notify') && notifyFails ? new Response('', { status: 500 }) : new Response('{}', { headers: { 'content-type': 'application/json' } })));
    const deployments = new DeploymentRegistry(testRegistry());
    const runs = new RunService(deployments, { services: makeServices(undefined, http) });
    const api = (id: string, url: string): FlowNode => ({ id, type: 'apiNode', trigger: false, values: { url, method: 'POST', body: '{}' } });
    await deployments.deploy('f', {
      nodes: [trigger(), api('charge', 'https://pay.example/charge'), api('notify', 'https://mail.example/notify'), response('{"done":true}')],
      edges: [edge('trigger', 'charge'), edge('charge', 'notify'), edge('notify', 'response')],
    });
    const failed = await runs.executeWorkflow('f', {});
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'UPSTREAM_HTTP', nodeId: 'notify', retryable: true });
    notifyFails = false;
    const retried = await runs.retryWorkflow(failed.requestId);
    expect(retried.status).toBe('success');
    expect(http.calls.filter((c) => c.url.includes('charge'))).toHaveLength(1);
  });
});


describe('run cancellation lifecycle', () => {
  it('does not execute nodes when the caller has already cancelled', async () => {
    const { deployments, runs, log } = setup();
    await deployments.deploy('f', flowDef('never'));
    const controller = new AbortController(); controller.abort();
    const result = await runs.executeWorkflow('f', {}, { signal: controller.signal });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('CANCELLED');
    expect(log.calls.size).toBe(0);
    expect(runs.load).toEqual({ active: 0, queued: 0 });
  });

  it('removes caller abort listeners when runs settle', async () => {
    const { deployments, runs } = setup();
    await deployments.deploy('f', flowDef('done'));
    const controller = new AbortController();
    for (let i = 0; i < 12; i++) {
      expect((await runs.executeWorkflow('f', {}, { signal: controller.signal })).status).toBe('success');
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
  });
});
