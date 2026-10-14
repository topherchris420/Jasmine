import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileFlow } from '../src/flow/compile.ts';
import type { FlowEdge, FlowNode } from '../src/flow/schema.ts';
import { resolveString, resolveValue } from '../src/flow/template.ts';
import { MockLLMProvider, StaticLLMRouter } from '../src/llm/providers.ts';
import { defaultRegistry } from '../src/nodes/builtin.ts';
import type { NodeRegistry, Services } from '../src/nodes/types.ts';
import { executePlan } from '../src/runtime/executor.ts';
import { edge, makeServices, newLog, plan, probe, response, testRegistry, trigger } from './helpers.ts';

/** A probe that can ignore its AbortSignal, while tracking how many handlers run at once. */
function hardeningRegistry(state: { active: number; maxActive: number; completed: string[]; aborted: string[] }): NodeRegistry {
  const reg = testRegistry(newLog());
  reg.register({
    type: 'tracked',
    kind: 'action',
    async run(ctx) {
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      const resolve = (key: string) => resolveValue(ctx.values[key], ctx.scope, { strict: false, nodeId: ctx.nodeId });
      const delay = Number(resolve('delayMs') ?? 0);
      try {
        if (ctx.values['ignoreSignal']) await sleep(delay);
        else if (delay > 0) await sleep(delay, undefined, { signal: ctx.signal });
        if (resolve('fail') === true) throw new Error(`boom in ${ctx.nodeId}`);
        state.completed.push(ctx.nodeId);
        return { output: { id: ctx.nodeId } };
      } catch (e) {
        if (ctx.signal.aborted) state.aborted.push(ctx.nodeId);
        throw e;
      } finally {
        state.active--;
      }
    },
  });
  return reg;
}

const node = (id: string, type: string, values: Record<string, unknown> = {}, logic?: FlowNode['logic']): FlowNode => ({ id, type, trigger: false, values, ...(logic ? { logic } : {}) });

describe('#1 node timeout and concurrency slots', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
  afterEach(() => process.off('unhandledRejection', onUnhandled));

  it('starts a node timeout only after a permit is acquired, not while queued', async () => {
    const log = newLog();
    const p = plan(
      [trigger(), probe('slow', { delayMs: 120 }), probe('quick', { delayMs: 10 }, { timeoutMs: 80 }), response('{"ok":true}')],
      [edge('trigger', 'slow'), edge('trigger', 'quick'), edge('slow', 'response'), edge('quick', 'response')],
      testRegistry(log),
    );
    const res = await executePlan(p, { payload: {}, services: makeServices(), concurrency: 1 });
    // Queued behind `slow` for ~120 ms, `quick` still only sees its 80 ms budget start when it runs.
    expect(res.nodes['quick']?.status).toBe('success');
    expect(res.status).toBe('success');
  });

  it('does not leave a dropped rejection or exceed the concurrency limit when a handler ignores its abort', async () => {
    const state = { active: 0, maxActive: 0, completed: [] as string[], aborted: [] as string[] };
    const p = plan(
      [trigger(), node('stuck', 'tracked', { delayMs: 150, ignoreSignal: true }, { timeoutMs: 40, retry: { maxAttempts: 2, delayMs: 0, backoff: 'fixed', jitter: false } }), node('other', 'tracked', { delayMs: 30 }), response('{"ok":true}')],
      [edge('trigger', 'stuck'), edge('trigger', 'other'), edge('stuck', 'response'), edge('other', 'response')],
      hardeningRegistry(state),
    );
    const res = await executePlan(p, { payload: {}, services: makeServices(), concurrency: 1 });
    expect(res.status).toBe('failed');
    expect(res.nodes['stuck']?.error?.code).toBe('TIMEOUT');
    // Permit follows the handler: with concurrency 1 only one `tracked` body runs at a time.
    expect(state.maxActive).toBe(1);
    await sleep(250); // let the ignored-signal handlers finish and settle their (handled) rejections
    expect(unhandled).toEqual([]);
  });
});

describe('#2 template expression sandbox', () => {
  const scope = new Map<string, unknown>([['a', { output: { x: 1 } }]]);

  it('rejects an expression that evaluates to a promise instead of letting its jobs escape', () => {
    expect(() => resolveString('{{ a.output.x && Promise.resolve(1) }}', scope, { strict: true })).toThrow(/promise/i);
  });

  it('bounds a self-perpetuating microtask chain to the evaluation budget', () => {
    const t0 = Date.now();
    expect(() => resolveString('{{ a.output.x && ((f => f(f))(f => Promise.resolve().then(() => f(f))), 1) }}', scope, { strict: true })).toThrow();
    expect(Date.now() - t0).toBeLessThan(2000); // the 100 ms vm budget, not the host event loop forever
  });

  it('still evaluates ordinary expressions', () => {
    expect(resolveString("{{ a.output.x == 1 ? 'yes' : 'no' }}", scope, { strict: true })).toBe('yes');
  });
});

describe('#3 Code node template values are data, not code', () => {
  const handler = defaultRegistry().get('codeNode')!;
  const services: Services = { ...makeServices(), codeTimeoutMs: 2000 };
  const runCode = (code: string, payload: unknown) =>
    handler.run({
      node: { id: 'code', type: 'codeNode', trigger: false, values: { code } }, nodeId: 'code', values: { code },
      runId: 'r', flowId: 'f', attempt: 1, idempotencyKey: 'k', signal: new AbortController().signal, emit: () => {},
      scope: new Map([['trigger', { output: payload }]]), payload, strictTemplates: false, services,
    });

  it('does not let a payload value break out of a surrounding string literal', async () => {
    const r = await runCode("output = { r: 'Hi {{trigger.output.name}}' };", { name: "'; globalThis.__pwn = 1; r = 'INJECTED'; '" });
    expect((r.output as { r: string }).r).not.toBe('INJECTED');
    expect((globalThis as Record<string, unknown>).__pwn).toBeUndefined();
  });

  it('exposes referenced values as real JS data in expression position', async () => {
    await expect(runCode('output = { r: {{trigger.output.n}} * 2 };', { n: 21 })).resolves.toEqual({ output: { r: 42 } });
    await expect(runCode('const v = {{trigger.output.obj}}; output = { r: v.items.length };', { obj: { items: [1, 2, 3] } })).resolves.toEqual({ output: { r: 3 } });
  });
});

describe('#4 batch iterations fail fast', () => {
  it('cancels in-flight sibling iterations when one fails', async () => {
    const state = { active: 0, maxActive: 0, completed: [] as string[], aborted: [] as string[] };
    const p = plan(
      [
        trigger(),
        node('batch', 'batchNode', { iteratorValue: '[0,1,2,3]', concurrencyLimit: 4, connectedTo: 'batchEnd' }),
        node('work', 'tracked', { delayMs: '{{ batch.output.index == 0 ? 10 : 500 }}', fail: '{{ batch.output.index == 0 }}' }),
        node('batchEnd', 'batchEndNode', { connectedTo: 'batch' }),
        response('{"ok":true}'),
      ],
      [edge('trigger', 'batch'), edge('batch', 'work'), edge('work', 'batchEnd'), edge('batchEnd', 'response')],
      hardeningRegistry(state),
    );
    const t0 = Date.now();
    const res = await executePlan(p, { payload: {}, services: makeServices(), strictTemplates: false });
    expect(res.status).toBe('failed');
    expect(Date.now() - t0).toBeLessThan(400); // did not wait for the 500 ms siblings
    expect(state.aborted.length).toBeGreaterThan(0);
    expect(state.completed).not.toContain('work'); // no sibling ran to completion
  });
});

describe('#5 supervisor decisions use the node policy and permits', () => {
  const agentPlan = (logic?: FlowNode['logic']) => [
    [
      trigger(),
      node('sup', 'agentNode', { prompts: [{ role: 'user', content: 'q {{trigger.output.n}}' }], agents: [{ name: 'R', schema: '{"q":"string"}' }], connectedTo: 'end', maxIterations: 3 }, logic),
      probe('R'),
      node('end', 'agentLoopEndNode', { connectedTo: 'sup' }),
      response('{"ok":true}'),
    ],
    [edge('trigger', 'sup'), edge('sup', 'R', 'R'), edge('R', 'end'), edge('end', 'response')],
  ] as [FlowNode[], FlowEdge[]];

  it('retries a retryable supervisor failure under the agent node retry policy', async () => {
    const llm = new MockLLMProvider({ respond: (_r, call) => (call === 1 ? 'not json at all' : '{"next":"FINISH","final_answer":"done"}') });
    const services: Services = { llm: new StaticLLMRouter({ mock: llm }, 'mock', 'mock-model'), fetch: globalThis.fetch, codeTimeoutMs: 1000 };
    const [nodes, edges] = agentPlan({ retry: { maxAttempts: 3, delayMs: 0, backoff: 'fixed', jitter: false } });
    const res = await executePlan(plan(nodes, edges), { payload: { n: 1 }, services });
    expect(res.status).toBe('success');
    expect(llm.calls).toBe(2); // first decide failed (bad JSON), retried, then finished
  });

  it('bounds concurrent supervisor model calls to the run concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const counting = {
      name: 'counting',
      async generate(req: { model: string; signal: AbortSignal }) {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await sleep(30, undefined, { signal: req.signal });
          return { text: '{"next":"FINISH","final_answer":"ok"}', inputTokens: 1, outputTokens: 1, model: req.model };
        } finally {
          active--;
        }
      },
    };
    const services: Services = { llm: new StaticLLMRouter({ mock: counting as never }, 'mock', 'mock-model'), fetch: globalThis.fetch, codeTimeoutMs: 1000 };
    const p = plan(
      [
        trigger(),
        node('batch', 'batchNode', { iteratorValue: '[0,1,2,3,4,5]', concurrencyLimit: 6, connectedTo: 'batchEnd' }),
        node('sup', 'agentNode', { prompts: [{ role: 'user', content: 'q {{batch.output.index}}' }], agents: [{ name: 'R' }], connectedTo: 'end' }),
        probe('R'),
        node('end', 'agentLoopEndNode', { connectedTo: 'sup' }),
        node('batchEnd', 'batchEndNode', { connectedTo: 'batch' }),
        response('{"ok":true}'),
      ],
      [edge('trigger', 'batch'), edge('batch', 'sup'), edge('sup', 'R', 'R'), edge('R', 'end'), edge('end', 'batchEnd'), edge('batchEnd', 'response')],
    );
    const res = await executePlan(p, { payload: {}, services, concurrency: 2 });
    expect(res.status).toBe('success');
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe('#9 loop body nodes must reach the loop end', () => {
  const base = (bodyEdges: FlowEdge[]): [FlowNode[], FlowEdge[]] => [
    [
      trigger(),
      node('loop', 'forLoopNode', { iteratorValue: '[1,2]', connectedTo: 'loopEnd' }),
      probe('collect', { value: '{{loop.output.currentValue}}' }),
      probe('notify', { value: '{{loop.output.currentValue}}' }),
      node('loopEnd', 'forLoopEndNode', { connectedTo: 'loop' }),
      response('{"n":"{{loopEnd.output.iterations}}"}'),
    ],
    [edge('trigger', 'loop'), edge('loop', 'collect'), edge('collect', 'loopEnd'), ...bodyEdges, edge('loopEnd', 'response')],
  ];

  it('reports a compile error naming a node that hangs off the loop start without reaching the end', () => {
    const [nodes, edges] = base([edge('loop', 'notify')]); // notify never reaches loopEnd
    const result = compileFlow({ id: 'f', nodes, edges }, testRegistry());
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOOP_BODY_LEAK', nodeId: 'notify' }));
  });

  it('accepts a loop body node that does reach the loop end', () => {
    const [nodes, edges] = base([edge('loop', 'notify'), edge('notify', 'loopEnd')]);
    const result = compileFlow({ id: 'f', nodes, edges }, testRegistry());
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  });
});

describe('#12 numeric range loops', () => {
  const rangeIterations = async (values: Record<string, unknown>) => {
    const p = plan(
      [
        trigger(),
        node('loop', 'forLoopNode', { iterateOver: 'range', connectedTo: 'loopEnd', ...values }),
        probe('body'),
        node('loopEnd', 'forLoopEndNode', { connectedTo: 'loop' }),
        response('{"n":"{{loopEnd.output.iterations}}"}'),
      ],
      [edge('trigger', 'loop'), edge('loop', 'body'), edge('body', 'loopEnd'), edge('loopEnd', 'response')],
    );
    const res = await executePlan(p, { payload: {}, services: makeServices() });
    return (res.output as { n: number }).n;
  };

  it('does not run an extra iteration from floating-point drift', async () => {
    expect(await rangeIterations({ initialValue: 0, endValue: 1, increment: 0.1 })).toBe(10);
  });

  it('keeps integer ranges exact and end-exclusive', async () => {
    expect(await rangeIterations({ initialValue: 0, endValue: 5, increment: 1 })).toBe(5);
    expect(await rangeIterations({ initialValue: 2, endValue: 10, increment: 2 })).toBe(4);
  });
});
