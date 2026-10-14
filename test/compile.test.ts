import { describe, expect, it } from 'vitest';
import { versionOf } from '../src/canonical.ts';
import { compileFlow } from '../src/flow/compile.ts';
import { importStudioFlow } from '../src/flow/import.ts';
import type { FlowEdge, FlowNode } from '../src/flow/schema.ts';
import { defaultRegistry } from '../src/nodes/builtin.ts';
import { edge, probe, response, studioArticleSummariser, testRegistry, trigger } from './helpers.ts';

const compile = (nodes: FlowNode[], edges: FlowEdge[]) => compileFlow({ id: 'f', nodes, edges }, testRegistry());
const codes = (r: ReturnType<typeof compile>, severity?: 'error' | 'warning') =>
  r.diagnostics.filter((d) => !severity || d.severity === severity).map((d) => d.code);

describe('graph validation', () => {
  it('compiles a linear flow into a deterministic order', () => {
    const r = compile([trigger(), probe('a'), probe('b'), response('{"x":"{{b.output.id}}"}')], [edge('trigger', 'a'), edge('a', 'b'), edge('b', 'response')]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.root.members).toEqual(['a', 'b', 'response']);
  });

  it('reports cycles with the offending path', () => {
    const r = compile([trigger(), probe('a'), probe('b'), probe('c'), response('{}')], [edge('trigger', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'response')]);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'CYCLE')?.message).toContain('a -> b -> c -> a');
  });

  it('warns about and prunes unreachable nodes', () => {
    const r = compile([trigger(), probe('a'), probe('orphan'), response('{}')], [edge('trigger', 'a'), edge('a', 'response')]);
    expect(r.ok).toBe(true);
    expect(codes(r, 'warning')).toContain('UNREACHABLE_NODE');
    if (r.ok) expect(r.plan.nodes.has('orphan')).toBe(false);
  });

  it('requires exactly one trigger, and a reachable response when the flow has response nodes', () => {
    expect(codes(compile([probe('a'), response('{}')], [edge('a', 'response')]))).toContain('NO_TRIGGER');
    expect(codes(compile([trigger(), { ...trigger(), id: 't2' }, response('{}')], [edge('trigger', 'response')]))).toContain('MULTIPLE_TRIGGERS');
    expect(codes(compile([trigger(), probe('a'), response('{}')], [edge('trigger', 'a')]), 'error')).toContain('NO_RESPONSE');
    // Background flows (indexing, schedules) may have no response node at all.
    const background = compile([trigger(), probe('a')], [edge('trigger', 'a')]);
    expect(background.ok).toBe(true);
    expect(codes(background, 'warning')).toContain('NO_RESPONSE');
  });

  it('flags references to missing nodes but not bare prompt placeholders', () => {
    const missing = compile([trigger(), probe('a', { text: '{{ghost.output.text}}' }), response('{}')], [edge('trigger', 'a'), edge('a', 'response')]);
    expect(codes(missing, 'error')).toContain('UNKNOWN_REFERENCE');
    const placeholder = compile([trigger(), probe('a', { text: 'Reply in {{language}}' }), response('{}')], [edge('trigger', 'a'), edge('a', 'response')]);
    expect(placeholder.ok).toBe(true);
    expect(codes(placeholder)).not.toContain('UNKNOWN_REFERENCE');
  });

  it('rejects node types the runtime cannot execute', () => {
    const r = compile([trigger(), { id: 'x', type: 'teleportNode', trigger: false, values: {} }, response('{}')], [edge('trigger', 'x'), edge('x', 'response')]);
    expect(codes(r, 'error')).toEqual(['UNSUPPORTED_NODE_TYPE']);
  });

  it('explains cloud-only integrations instead of failing at run time', () => {
    const r = compile([trigger(), { id: 'x', type: 'googleDriveNode', trigger: false, values: {} }, response('{}')], [edge('trigger', 'x'), edge('x', 'response')]);
    expect(codes(r, 'error')).toEqual(['INTEGRATION_UNAVAILABLE']);
  });
});

describe('reference validation', () => {
  // trigger -> a -> reader -> response, and trigger -> sibling -> response (sibling runs in parallel with reader)
  const withReader = (ref: string) =>
    compile(
      [trigger(), probe('a'), probe('sibling'), probe('reader', { value: ref }), response('{}')],
      [edge('trigger', 'a'), edge('trigger', 'sibling'), edge('a', 'reader'), edge('reader', 'response'), edge('sibling', 'response')],
    );

  it('rejects references to nodes that do not exist', () => {
    expect(codes(withReader('{{nope.output}}'))).toContain('UNKNOWN_REFERENCE');
  });

  it('rejects references to nodes that are not upstream (timing-dependent values)', () => {
    expect(codes(withReader('{{sibling.output.id}}'))).toContain('REFERENCE_NOT_UPSTREAM');
    expect(codes(withReader('{{a.output.id}}'), 'error')).toEqual([]);
  });

  it('warns when a node reads a value that a branch may have skipped', () => {
    const nodes = [
      trigger(),
      { id: 'gate', type: 'gate', trigger: false, values: {} },
      probe('yes'),
      probe('no'),
      probe('join', { value: '{{yes.output.id}}' }),
      probe('after', { value: '{{join.output.id}}' }),
      response('{}'),
    ];
    const edges = [edge('trigger', 'gate'), edge('gate', 'yes', 'yes'), edge('gate', 'no', 'no'), edge('yes', 'join'), edge('no', 'join'), edge('join', 'after'), edge('after', 'response')];
    const r = compile(nodes, edges);
    expect(r.ok).toBe(true);
    const warnings = r.diagnostics.filter((d) => d.code === 'CONDITIONAL_REFERENCE');
    expect(warnings.map((d) => d.nodeId)).toEqual(['join']);
  });

  it('rejects reads of per-iteration loop values from outside the loop', () => {
    const nodes: FlowNode[] = [
      trigger(),
      { id: 'loop', type: 'forLoopNode', trigger: false, values: { iterateOver: 'list', iteratorValue: '{{trigger.output.items}}', connectedTo: 'end' } },
      probe('body', { value: '{{loop.output.currentValue}}' }),
      { id: 'end', type: 'forLoopEndNode', trigger: false, values: { connectedTo: 'loop' } },
      probe('after', { value: '{{body.output.value}}' }),
      response('{}'),
    ];
    const edges: FlowEdge[] = [edge('trigger', 'loop'), edge('loop', 'body'), edge('body', 'end'), { source: 'end', target: 'loop', kind: 'loop' }, edge('end', 'after'), edge('after', 'response')];
    const r = compile(nodes, edges);
    expect(codes(r, 'error')).toEqual(['REFERENCE_INTO_LOOP']);
  });
});

describe('node config validation', () => {
  it('blocks forbidden code and bad condition operators at compile time', () => {
    const r = compile(
      [
        trigger(),
        { id: 'code', type: 'codeNode', trigger: false, values: { code: 'output = require("fs")' } },
        { id: 'cond', type: 'conditionNode', trigger: false, values: { conditions: [{ label: 'A', value: 'cond-x', condition: '{"operator":null,"operands":[{"name":"1","operator":"~=","value":"1"}]}' }, { label: 'Else', value: 'cond-y', condition: {} }] } },
        response('{}'),
      ],
      [edge('trigger', 'code'), edge('code', 'cond'), { source: 'cond', target: 'response', kind: 'condition', branch: 'cond-x' }],
    );
    expect(codes(r, 'error').sort()).toEqual(['CODE_FORBIDDEN', 'CONDITION_INVALID']);
  });
});

describe('Studio export import', () => {
  it('imports the public export shape: placeholders pruned, response edge ignored, apiNode retries mapped', () => {
    const { definition, diagnostics } = importStudioFlow(studioArticleSummariser(), { flowId: 'article' });
    expect(diagnostics).toEqual([]);
    expect(definition.nodes.map((n) => n.id)).not.toContain('addNode_9');
    expect(definition.nodes.find((n) => n.id === 'apiNode_252')?.logic?.retry).toEqual({ maxAttempts: 3, delayMs: 0, backoff: 'fixed', jitter: false });
    const r = compileFlow(definition, defaultRegistry());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.root.members).toEqual(['apiNode_252', 'LLMNode_160', 'graphqlResponseNode_651']);
  });

  it('maps condition edges by value suffix, falling back to position with a warning', () => {
    const cond = (value1: string) => ({
      nodes: [
        { id: 't', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
        { id: 'c', type: 'dynamicNode', data: { nodeId: 'conditionNode', values: { conditions: [
          { label: 'Yes', value: value1, condition: '{"operator":null,"operands":[{"name":"{{t.output.ok}}","operator":"==","value":"true"}]}' },
          { label: 'Else', value: 'c-addNode_2', condition: {} },
        ] } } },
        { id: 'r1', type: 'dynamicNode', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"r":1}' } } },
        { id: 'r2', type: 'dynamicNode', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"r":2}' } } },
      ],
      edges: [
        { source: 't', target: 'c', type: 'defaultEdge' },
        { source: 'c', target: 'r1', type: 'conditionEdge' },
        { source: 'c', target: 'r2', type: 'conditionEdge' },
      ],
    });
    const exact = importStudioFlow(cond('c-r1'), { flowId: 'x' });
    expect(exact.definition.edges.find((e) => e.target === 'r1')?.branch).toBe('c-r1');
    expect(exact.diagnostics.map((d) => d.code)).toEqual(['IMPORT_BRANCH_BY_POSITION']);
    const stale = importStudioFlow(cond('c-addNode_1'), { flowId: 'x' });
    expect(stale.diagnostics.map((d) => d.code)).toEqual(['IMPORT_BRANCH_BY_POSITION', 'IMPORT_BRANCH_BY_POSITION']);
  });

  it('flags unresolved @prompts/@scripts file references instead of sending the path to the model', () => {
    const exp = studioArticleSummariser();
    (exp.nodes[2]!.data.values as Record<string, unknown>)['prompts'] = [{ role: 'user', content: '@prompts/summarise_user.md' }];
    const { definition } = importStudioFlow(exp, { flowId: 'a' });
    expect(compileFlow(definition, defaultRegistry()).diagnostics.map((d) => d.code)).toContain('FILE_REF_UNRESOLVED');
    const resolved = importStudioFlow(exp, { flowId: 'a', resolveFileRef: () => 'Summarise: {{apiNode_252.output}}' });
    expect(compileFlow(resolved.definition, defaultRegistry()).ok).toBe(true);
  });
});

describe('versioning', () => {
  it('is content-addressed and independent of key order', () => {
    expect(versionOf({ a: 1, b: { c: 2, d: 3 } })).toBe(versionOf({ b: { d: 3, c: 2 }, a: 1 }));
    expect(versionOf({ a: 1 })).not.toBe(versionOf({ a: 2 }));
  });
});
