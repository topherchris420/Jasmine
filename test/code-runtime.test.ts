import { describe, expect, it } from 'vitest';
import { defaultRegistry } from '../src/nodes/builtin.ts';
import type { NodeContext } from '../src/nodes/types.ts';
import { makeServices } from './helpers.ts';

const handler = defaultRegistry().get('codeNode')!;
function context(code: string, timeoutMs = 2000, signal = new AbortController().signal): NodeContext {
  const node = { id: 'code', type: 'codeNode', trigger: false, values: { code } };
  return {
    node, nodeId: node.id, values: node.values, signal,
    runId: 'worker-test', attempt: 1, idempotencyKey: 'worker-test',
    scope: new Map([['trigger', { output: { value: 'student' } }]]), payload: {},
    strictTemplates: true, services: { ...makeServices(), codeTimeoutMs: timeoutMs },
  };
}

describe('code node worker lifecycle', () => {
  it('resolves templates, awaits code, and prefers assigned output to return', async () => {
    const ctx = context('await Promise.resolve(); console.log("example"); output = { name: {{trigger.output.value}}, n: 2 }; return "ignored";');
    expect(handler.validate!(ctx.node)).toEqual([]);
    await expect(handler.run(ctx)).resolves.toEqual({ output: { name: 'student', n: 2 } });
  });

  it('accepts return values and empty output', async () => {
    await expect(handler.run(context('return [1, 2, 3];'))).resolves.toEqual({ output: [1, 2, 3] });
    await expect(handler.run(context('await Promise.resolve();'))).resolves.toEqual({ output: undefined });
  });

  it('creates console functions and objects in the code realm', async () => {
    await expect(handler.run(context('return { fn: Object.getPrototypeOf(console.log) === Function.prototype, obj: Object.getPrototypeOf(console) === Object.prototype };'))).resolves.toEqual({ output: { fn: true, obj: true } });
  });

  it.each(['while (true) {}', 'await Promise.resolve(); while (true) {}'])('terminates an infinite loop and leaves the server responsive: %s', async (code) => {
    const ctx = context(code, 350);
    let heartbeat = false;
    const beat = setTimeout(() => { heartbeat = true; }, 30);
    try {
      await expect(handler.run(ctx)).rejects.toMatchObject({ code: 'CODE_ERROR', message: expect.stringContaining('timed out') });
      expect(heartbeat).toBe(true);
      await expect(handler.run(context('return "recovered";'))).resolves.toEqual({ output: 'recovered' });
    } finally { clearTimeout(beat); }
  });

  it('cancels running code with the original abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('Student cancelled');
    const pending = handler.run(context('await Promise.resolve(); while (true) {}', 5000, controller.signal));
    const cancellation = setTimeout(() => controller.abort(reason), 350);
    try {
      await expect(pending).rejects.toBe(reason);
      await expect(handler.run(context('return 42;'))).resolves.toEqual({ output: 42 });
    } finally { clearTimeout(cancellation); }
  });

  it('does not execute an already-cancelled node', async () => {
    const controller = new AbortController();
    const reason = new Error('Already cancelled');
    controller.abort(reason);
    await expect(handler.run(context('while (true) {}', 5000, controller.signal))).rejects.toBe(reason);
  });

  it('reports runtime and uncloneable-output errors without hanging', async () => {
    await expect(handler.run(context('throw new Error("Example failure");'))).rejects.toMatchObject({ code: 'CODE_ERROR', message: expect.stringContaining('Example failure') });
    await expect(handler.run(context('return () => 1;'))).rejects.toMatchObject({ code: 'CODE_ERROR' });
  });
});
