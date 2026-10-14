import { describe, expect, it } from 'vitest';
import { createTestApp, withHttp } from './helpers.ts';
// JavaScript is also the executable CLI entry point.
// @ts-expect-error standalone ESM script
import { compareFlows, compareValues } from '../scripts/parity-compare.mjs';

describe('cross-implementation comparison', () => {
  it('detects structural and numeric differences and ignores only declared paths', () => {
    expect(compareValues({ a: 1, b: 2 }, { a: 1, b: 3 }).equal).toBe(false);
    expect(compareValues({ a: 1, b: 2 }, { a: 1, b: 3 }, { ignorePaths: ['/b'] }).equal).toBe(true);
    expect(compareValues({ value: 0.1 }, { value: 0.10001 }, { numericTolerance: 0.001 }).equal).toBe(true);
    expect(compareValues([1, 2], [2, 1]).equal).toBe(false);
    expect(compareValues({ empty: null }, {}).equal).toBe(false);
  });
  it('compares real deployed flows and fails when expected behavior is wrong even if both implementations agree', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('echo', {
        nodes: [
          { id: 't', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
          { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{{t.output}}' } } },
        ],
        edges: [{ source: 't', target: 'r' }],
      });
      await withHttp(t.app, async (base) => {
        const targets = { reference: { endpoint: base + '/graphql' }, jasmine: { endpoint: base + '/graphql' } };
        const fixture = {
          name: 'echo',
          referenceFlowId: 'echo',
          jasmineFlowId: 'echo',
          payload: { nested: { value: 42 } },
          expected: { nested: { value: 42 } },
        };
        expect((await compareFlows({ cases: [fixture] }, targets)).passed).toBe(true);
        const failure = await compareFlows({ cases: [{ ...fixture, expected: { incorrect: true } }] }, targets);
        expect(failure.passed).toBe(false);
        expect(failure.cases[0].expectedPassed).toBe(false);
      });
    } finally {
      await t.close();
    }
  });
});
