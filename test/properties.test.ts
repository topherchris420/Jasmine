import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileFlow } from '../src/flow/compile.ts';
import type { FlowEdge, FlowNode } from '../src/flow/schema.ts';
import { executePlan } from '../src/runtime/executor.ts';
import { makeServices, newLog, response, testRegistry, trigger } from './helpers.ts';

interface RandomFlow {
  n: number;
  kinds: ('probe' | 'gate')[];
  picks: ('yes' | 'no')[];
  delays: number[];
  pairs: [number, number, 'yes' | 'no'][];
  concurrency: number;
}

const flowArb: fc.Arbitrary<RandomFlow> = fc.integer({ min: 2, max: 14 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    kinds: fc.array(fc.constantFrom<'probe' | 'gate'>('probe', 'gate'), { minLength: n, maxLength: n }),
    picks: fc.array(fc.constantFrom<'yes' | 'no'>('yes', 'no'), { minLength: n, maxLength: n }),
    delays: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: n, maxLength: n }),
    pairs: fc.array(fc.tuple(fc.nat(n - 1), fc.nat(n - 1), fc.constantFrom<'yes' | 'no'>('yes', 'no')), { maxLength: n * 2 }),
    concurrency: fc.constantFrom(1, 2, 8),
  }),
);

/** Random DAG: edges only go from lower to higher index, so it is acyclic by construction. */
function build(f: RandomFlow) {
  const id = (i: number) => `v${i}`;
  const nodes: FlowNode[] = [trigger()];
  for (let i = 0; i < f.n; i++) {
    nodes.push(f.kinds[i] === 'gate'
      ? { id: id(i), type: 'gate', trigger: false, values: { pick: f.picks[i] } }
      : { id: id(i), type: 'probe', trigger: false, values: { delayMs: f.delays[i] } });
  }
  nodes.push(response('{}'));
  const edges: FlowEdge[] = [];
  const seen = new Set<string>();
  const add = (s: string, t: string, branch?: string) => {
    const key = `${s}>${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(branch ? { source: s, target: t, kind: 'condition', branch } : { source: s, target: t, kind: 'default' });
  };
  for (const [a, b, branch] of f.pairs) {
    if (a === b) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    add(id(lo), id(hi), f.kinds[lo] === 'gate' ? branch : undefined);
  }
  for (let i = 0; i < f.n; i++) {
    if (!edges.some((e) => e.target === id(i))) add('trigger', id(i));
    if (!edges.some((e) => e.source === id(i))) add(id(i), 'response', f.kinds[i] === 'gate' ? f.picks[i] : undefined);
  }
  return { nodes, edges };
}

/** Reference semantics: a node runs iff at least one incoming edge is active. */
function expectedRuns(f: RandomFlow, edges: FlowEdge[]): Map<string, boolean> {
  const ran = new Map<string, boolean>([['trigger', true]]);
  const order = [...Array.from({ length: f.n }, (_, i) => `v${i}`), 'response'];
  for (const node of order) {
    const active = edges.filter((e) => e.target === node).some((e) => {
      if (!ran.get(e.source)) return false;
      if (!e.branch) return true;
      return f.picks[Number(e.source.slice(1))] === e.branch;
    });
    ran.set(node, active);
  }
  return ran;
}

describe('graph invariants (property-based)', () => {
  it('every acyclic flow compiles, and the plan order respects every edge', () => {
    fc.assert(
      fc.property(flowArb, (f) => {
        const { nodes, edges } = build(f);
        const r = compileFlow({ id: 'p', nodes, edges }, testRegistry());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const pos = new Map(r.plan.root.members.map((m, i) => [m, i]));
        for (const e of edges) if (e.source !== 'trigger') expect(pos.get(e.source)!).toBeLessThan(pos.get(e.target)!);
      }),
      { numRuns: 300 },
    );
  });

  it('reversing any edge is always reported as a cycle', () => {
    fc.assert(
      fc.property(flowArb, fc.nat(), (f, pick) => {
        const { nodes, edges } = build(f);
        const internal = edges.filter((e) => e.source !== 'trigger' && e.target !== 'response');
        fc.pre(internal.length > 0);
        const e = internal[pick % internal.length]!;
        const back: FlowEdge = f.kinds[Number(e.target.slice(1))] === 'gate'
          ? { source: e.target, target: e.source, kind: 'condition', branch: 'yes' }
          : { source: e.target, target: e.source, kind: 'default' };
        const r = compileFlow({ id: 'p', nodes, edges: [...edges, back] }, testRegistry());
        expect(r.diagnostics.map((d) => d.code)).toContain('CYCLE');
      }),
      { numRuns: 300 },
    );
  });
});

describe('executor invariants (property-based)', () => {
  it('runs each node at most once, exactly when an active edge reaches it, after its predecessors, within the concurrency limit', async () => {
    await fc.assert(
      fc.asyncProperty(flowArb, async (f) => {
        const { nodes, edges } = build(f);
        const log = newLog();
        const r = compileFlow({ id: 'p', nodes, edges }, testRegistry(log));
        if (!r.ok) throw new Error('compile failed');
        const res = await executePlan(r.plan, { payload: {}, services: makeServices(), concurrency: f.concurrency });
        const expected = expectedRuns(f, edges);

        for (const [node, shouldRun] of expected) {
          if (node === 'trigger') continue;
          expect(res.nodes[node]?.status, node).toBe(shouldRun ? 'success' : 'skipped');
        }
        for (const [, count] of log.calls) expect(count).toBe(1);
        expect(log.maxActive).toBeLessThanOrEqual(f.concurrency);
        expect(res.status).toBe(expected.get('response') ? 'success' : 'failed');

        const idx = (id: string, kind: 'start' | 'end') => log.timeline.findIndex((e) => e.id === id && e.kind === kind);
        for (const e of edges) {
          if (!log.calls.has(e.source) || !log.calls.has(e.target)) continue;
          expect(idx(e.source, 'end')).toBeLessThan(idx(e.target, 'start'));
        }
      }),
      { numRuns: 150 },
    );
  });
});
