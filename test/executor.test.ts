import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../src/flow/schema.ts';
import { MockLLMProvider } from '../src/llm/providers.ts';
import { executePlan } from '../src/runtime/executor.ts';
import { toOtelSpans } from '../src/runtime/trace.ts';
import { edge, fakeFetch, makeServices, newLog, plan, probe, response, testRegistry, trigger } from './helpers.ts';

const services = makeServices();
const run = (p: ReturnType<typeof plan>, extra: Partial<Parameters<typeof executePlan>[1]> = {}) =>
  executePlan(p, { payload: { q: 1 }, services, ...extra });

describe('scheduling', () => {
  const fanOut = (log = newLog()) => {
    const workers = ['w1', 'w2', 'w3', 'w4'];
    return {
      log,
      plan: plan(
        [trigger(), ...workers.map((w) => probe(w, { delayMs: 40 })), probe('join'), response('{"n":"{{join.output.id}}"}')],
        [...workers.map((w) => edge('trigger', w)), ...workers.map((w) => edge(w, 'join')), edge('join', 'response')],
        testRegistry(log),
      ),
    };
  };

  it('runs independent nodes concurrently and respects the concurrency limit', async () => {
    const { log, plan: p } = fanOut();
    const res = await run(p, { concurrency: 2 });
    expect(res.status).toBe('success');
    expect(log.maxActive).toBe(2);
    const seq = await run(fanOut().plan, { concurrency: 1 });
    const par = await run(fanOut().plan, { concurrency: 8 });
    expect(seq.timeTakenMs).toBeGreaterThanOrEqual(160);
    expect(par.timeTakenMs).toBeLessThan(120);
  });

  it('starts a node only after every predecessor finished', async () => {
    const { log, plan: p } = fanOut();
    await run(p);
    const joinStart = log.timeline.findIndex((e) => e.id === 'join' && e.kind === 'start');
    for (const w of ['w1', 'w2', 'w3', 'w4']) {
      expect(log.timeline.findIndex((e) => e.id === w && e.kind === 'end')).toBeLessThan(joinStart);
    }
  });
});

describe('branching', () => {
  const ifElse = (pick: 'yes' | 'no', log = newLog()) =>
    plan(
      [trigger(), { id: 'gate', type: 'gate', trigger: false, values: { pick } }, probe('yes'), probe('no'), probe('join'), response('{"ok":true}')],
      [edge('trigger', 'gate'), edge('gate', 'yes', 'yes'), edge('gate', 'no', 'no'), edge('yes', 'join'), edge('no', 'join'), edge('join', 'response')],
      testRegistry(log),
    );

  it('runs only the taken branch, marks the other 304, and still runs the join', async () => {
    const log = newLog();
    const res = await run(ifElse('no', log));
    expect(res.status).toBe('success');
    expect(res.nodes['yes']).toMatchObject({ status: 'skipped', statusCode: 304 });
    expect(res.nodes['no']?.status).toBe('success');
    expect(log.calls.get('join')).toBe(1);
  });

  it('evaluates Studio conditionNode JSON conditions, including Else', async () => {
    const cond = (v: number) =>
      plan(
        [
          trigger(),
          { id: 'c', type: 'conditionNode', trigger: false, values: { conditions: [
            { label: 'Big', value: 'c-big', condition: '{"operator":null,"operands":[{"name":"{{trigger.output.n}}","operator":">","value":"10"}]}' },
            { label: 'Else', value: 'c-small', condition: {} },
          ] } },
          response('{"size":"big"}', 'big'),
          response('{"size":"small"}', 'small'),
        ],
        [edge('trigger', 'c'), edge('c', 'big', 'c-big'), edge('c', 'small', 'c-small')],
      );
    expect((await executePlan(cond(1), { payload: { n: 50 }, services })).output).toEqual({ size: 'big' });
    expect((await executePlan(cond(1), { payload: { n: 5 }, services })).output).toEqual({ size: 'small' });
  });
});

describe('failure handling', () => {
  it('fails fast: cancels in-flight siblings and never starts downstream nodes', async () => {
    const log = newLog();
    const p = plan(
      [trigger(), probe('bad', { failTimes: 1, retryable: false }), probe('slow', { delayMs: 500 }), probe('after'), response('{}')],
      [edge('trigger', 'bad'), edge('trigger', 'slow'), edge('bad', 'after'), edge('slow', 'after'), edge('after', 'response')],
      testRegistry(log),
    );
    const res = await run(p);
    expect(res.status).toBe('failed');
    expect(res.error).toMatchObject({ code: 'UPSTREAM_HTTP', nodeId: 'bad' });
    expect(log.aborted.has('slow')).toBe(true);
    expect(res.nodes['after']?.status).toBe('cancelled');
    expect(res.timeTakenMs).toBeLessThan(400);
  });

  it('retries transient failures and reports 509 attempts then 204 success', async () => {
    const p = plan([trigger(), probe('flaky', { failTimes: 2 }, { retry: { maxAttempts: 3, delayMs: 5, backoff: 'fixed', jitter: false } }), response('{}')], [edge('trigger', 'flaky'), edge('flaky', 'response')]);
    const res = await run(p);
    expect(res.nodes['flaky']).toMatchObject({ status: 'success', statusCode: 204, attempts: 3 });
    expect(res.trace.filter((e) => e.type === 'node.retry').map((e) => e.statusCode)).toEqual([509, 509]);
  });

  it('does not retry non-retryable errors', async () => {
    const log = newLog();
    const p = plan([trigger(), probe('x', { failTimes: 5, retryable: false }, { retry: { maxAttempts: 4, delayMs: 0, backoff: 'fixed', jitter: false } }), response('{}')], [edge('trigger', 'x'), edge('x', 'response')], testRegistry(log));
    await run(p);
    expect(log.calls.get('x')).toBe(1);
  });

  it('times out a slow node and retries it within its policy', async () => {
    const log = newLog();
    const p = plan([trigger(), probe('slow', { delayMs: 200 }, { timeoutMs: 20, retry: { maxAttempts: 2, delayMs: 0, backoff: 'fixed', jitter: false } }), response('{}')], [edge('trigger', 'slow'), edge('slow', 'response')], testRegistry(log));
    const res = await run(p);
    expect(res.error?.code).toBe('TIMEOUT');
    expect(log.calls.get('slow')).toBe(2);
    expect(res.timeTakenMs).toBeLessThan(150);
  });

  it('never blindly retries a non-idempotent side effect', async () => {
    const http = fakeFetch(() => new Response('upstream down', { status: 503 }));
    const api = (idempotent: boolean): FlowNode => ({
      id: 'charge', type: 'apiNode', trigger: false,
      values: { url: 'https://payments.example/charge', method: 'POST', body: '{"amount": {{trigger.output.amount}}}', idempotent },
      logic: { retry: { maxAttempts: 3, delayMs: 1, backoff: 'fixed', jitter: false } },
    });
    const flow = (idempotent: boolean) => plan([trigger(), api(idempotent), response('{}')], [edge('trigger', 'charge'), edge('charge', 'response')]);

    const unsafe = await executePlan(flow(false), { payload: { amount: 5 }, services: makeServices(undefined, http) });
    expect(http.calls).toHaveLength(1);
    expect(unsafe.trace.find((e) => e.type === 'node.failed')?.retrySuppressed).toBe('side-effect-not-idempotent');

    http.calls.length = 0;
    await executePlan(flow(true), { payload: { amount: 5 }, services: makeServices(undefined, http) });
    expect(http.calls).toHaveLength(3);
    const keys = new Set(http.calls.map((c) => (c.init.headers as Record<string, string>)['Idempotency-Key']));
    expect(keys.size).toBe(1);
  });

  it('does not schedule a retry the run deadline cannot accommodate', async () => {
    const p = plan([trigger(), probe('x', { failTimes: 5 }, { retry: { maxAttempts: 5, delayMs: 10_000, backoff: 'fixed', jitter: false } }), response('{}')], [edge('trigger', 'x'), edge('x', 'response')]);
    const res = await run(p, { deadlineMs: 500 });
    expect(res.timeTakenMs).toBeLessThan(200);
    expect(res.trace.find((e) => e.type === 'node.failed')?.retrySuppressed).toBe('deadline');
  });

  it('runs the fallback config when the primary times out (log code 408)', async () => {
    const p = plan(
      [trigger(), probe('llm', { delayMs: 300, value: 'primary' }, { fallback: { timeoutMs: 20, values: { delayMs: 0, value: 'fallback' } } }), response('{"v":"{{llm.output.value}}"}')],
      [edge('trigger', 'llm'), edge('llm', 'response')],
    );
    const res = await run(p);
    expect(res.output).toEqual({ v: 'fallback' });
    expect(res.nodes['llm']?.statusCode).toBe(408);
  });

  it('stops promptly when the caller cancels', async () => {
    const controller = new AbortController();
    const p = plan([trigger(), probe('long', { delayMs: 5_000 }), response('{}')], [edge('trigger', 'long'), edge('long', 'response')]);
    setTimeout(() => controller.abort(), 20);
    const res = await run(p, { signal: controller.signal });
    expect(res.error?.code).toBe('CANCELLED');
    expect(res.timeTakenMs).toBeLessThan(500);
  });

  it('fails loudly on a reference that resolves to nothing (strict) instead of sending an empty prompt', async () => {
    const p = plan([trigger(), probe('a', { value: 'Q: {{trigger.output.question}}' }), response('{}')], [edge('trigger', 'a'), edge('a', 'response')]);
    expect((await run(p, { payload: {} })).error?.code).toBe('TEMPLATE_UNRESOLVED');
    expect((await run(p, { payload: {}, strictTemplates: false })).status).toBe('success');
  });
});

describe('retry from failed node', () => {
  it('reuses completed side effects (208) and re-runs only what failed', async () => {
    let failCharge = true;
    const http = fakeFetch((url) => (url.includes('notify') && failCharge ? new Response('x', { status: 400 }) : new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })));
    const nodes: FlowNode[] = [
      trigger(),
      { id: 'charge', type: 'apiNode', trigger: false, values: { url: 'https://pay.example/charge', method: 'POST', body: '{}' } },
      { id: 'notify', type: 'apiNode', trigger: false, values: { url: 'https://mail.example/notify', method: 'POST', body: '{}' } },
      response('{"ok":true}'),
    ];
    const p = plan(nodes, [edge('trigger', 'charge'), edge('charge', 'notify'), edge('notify', 'response')]);
    const svc = makeServices(undefined, http);
    const first = await executePlan(p, { payload: {}, services: svc, runId: 'req-1' });
    expect(first.status).toBe('failed');
    failCharge = false;
    const second = await executePlan(p, { payload: {}, services: svc, previous: first, idempotencyRoot: 'req-1' });
    expect(second.status).toBe('success');
    expect(second.nodes['charge']).toMatchObject({ statusCode: 208, reused: true });
    expect(http.calls.filter((c) => c.url.includes('charge'))).toHaveLength(1);
    const notifyKeys = http.calls.filter((c) => c.url.includes('notify')).map((c) => (c.init.headers as Record<string, string>)['Idempotency-Key']);
    expect(new Set(notifyKeys).size).toBe(1);
  });
});

describe('loops', () => {
  const loopFlow = (items: string) =>
    plan(
      [
        trigger(),
        { id: 'loop', type: 'forLoopNode', trigger: false, values: { iterateOver: 'list', iteratorValue: items, connectedTo: 'end' } },
        { id: 'double', type: 'codeNode', trigger: false, values: { code: 'output = {{loop.output.currentValue}} * 2;' } },
        { id: 'end', type: 'forLoopEndNode', trigger: false, values: { connectedTo: 'loop' } },
        response('{"doubled": "{{end.output.loopOutput}}"}'),
      ],
      [edge('trigger', 'loop'), edge('loop', 'double'), edge('double', 'end'), { source: 'end', target: 'loop', kind: 'loop' }, edge('end', 'response')],
    );

  it('runs the body once per item and collects loopOutput keyed by node id', async () => {
    const res = await executePlan(loopFlow('{{trigger.output.items}}'), { payload: { items: [1, 2, 3] }, services });
    expect(res.output).toEqual({ doubled: [{ double: { output: 2 } }, { double: { output: 4 } }, { double: { output: 6 } }] });
    expect(res.trace.filter((e) => e.type === 'node.success' && e.nodeId === 'double').map((e) => e.iteration)).toEqual([[0], [1], [2]]);
  });

  it('enforces an iteration limit', async () => {
    const res = await executePlan(loopFlow('{{trigger.output.items}}'), { payload: { items: Array(50).fill(1) }, services, maxLoopIterations: 10 });
    expect(res.error?.code).toBe('LOOP_LIMIT');
  });
});

describe('LLM nodes', () => {
  it('retries invalid structured output and counts tokens for every attempt', async () => {
    const llm = new MockLLMProvider({ respond: (_r, call) => (call === 1 ? 'not json' : '{"title":"ok"}') });
    const p = plan(
      [
        trigger(),
        { id: 'ex', type: 'InstructorLLMNode', trigger: false, values: { prompts: [{ role: 'user', content: 'Extract' }], schema: '{"type":"object","required":["title"],"properties":{"title":{"type":"string"}}}' }, logic: { retry: { maxAttempts: 2, delayMs: 0, backoff: 'fixed', jitter: false } } },
        response('{"title":"{{ex.output.title}}"}'),
      ],
      [edge('trigger', 'ex'), edge('ex', 'response')],
    );
    const res = await executePlan(p, { payload: {}, services: makeServices(llm) });
    expect(res.output).toEqual({ title: 'ok' });
    expect(res.usage.llmCalls).toBe(2);
  });
});

describe('observability', () => {
  it('keeps secrets out of traces and exports OpenTelemetry-shaped spans', async () => {
    const p = plan([trigger(), probe('a', { value: '{{trigger.output}}' }), response('{}')], [edge('trigger', 'a'), edge('a', 'response')]);
    const res = await executePlan(p, { payload: { apiKey: 'sk-live-abcdefghijklmnop', note: 'Bearer abcdefghijklmnopqrstu' }, services, traceOutputs: 'preview' });
    const text = JSON.stringify(res.trace);
    expect(text).not.toContain('sk-live-abcdefghijklmnop');
    expect(text).not.toContain('abcdefghijklmnopqrstu');
    const spans = toOtelSpans(res.trace);
    expect(spans.map((s) => s.name)).toEqual(['flow flow', 'graphqlNode trigger', 'probe a', 'graphqlResponseNode response']);
    expect(spans.every((s) => s.traceId === spans[0]!.traceId)).toBe(true);
  });

  it('records the version that executed and a stable input hash for diffing runs', async () => {
    const p = plan([trigger(), probe('a', { value: '{{trigger.output.q}}' }), response('{}')], [edge('trigger', 'a'), edge('a', 'response')]);
    const [r1, r2, r3] = await Promise.all([run(p, { payload: { q: 1 } }), run(p, { payload: { q: 1 } }), run(p, { payload: { q: 2 } })]);
    const hash = (r: typeof r1) => r.trace.find((e) => e.type === 'node.start' && e.nodeId === 'a')?.inputHash;
    expect(hash(r1)).toBe(hash(r2));
    expect(hash(r1)).not.toBe(hash(r3));
    expect(r1.version).toBe(p.version);
  });
});

