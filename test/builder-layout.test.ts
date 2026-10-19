import { describe, expect, it } from 'vitest';
// @ts-expect-error Studio modules are plain JavaScript without type declarations.
import { autoLayout, hasOverlap, NODE_W } from '../public/js/builder/graph.js';

const node = (id: string, nodeId: string) => ({ id, type: 'customNode', position: { x: 0, y: 0 }, data: { nodeId, values: {} } });
const edge = (source: string, target: string, type = 'defaultEdge') => ({ id: `${source}-${target}`, source, target, type });

describe('builder auto layout', () => {
  it('spaces rows by the measured height of their tallest step so branches never overlap', () => {
    const def = {
      nodes: [node('trigger', 'graphqlNode'), node('classify', 'agentClassifierNode'), node('a', 'graphqlResponseNode'), node('b', 'graphqlResponseNode'), node('c', 'graphqlResponseNode')],
      edges: [edge('trigger', 'classify'), edge('classify', 'a', 'agentClassifierEdge'), edge('classify', 'b', 'agentClassifierEdge'), edge('classify', 'c', 'agentClassifierEdge')],
    };
    const sizes = new Map([['trigger', { w: NODE_W, h: 110 }], ['classify', { w: NODE_W, h: 320 }], ['a', { w: NODE_W, h: 110 }], ['b', { w: NODE_W, h: 110 }], ['c', { w: NODE_W, h: 110 }]]);
    autoLayout(def, new Map([...sizes].map(([id, s]) => [id, s.h])));
    const pos = (id: string) => def.nodes.find((n) => n.id === id)!.position;
    expect(pos('classify').y).toBeGreaterThanOrEqual(pos('trigger').y + 110);
    // The tall classifier pushes its branches below its full height, not a fixed row height.
    expect(pos('a').y).toBeGreaterThanOrEqual(pos('classify').y + 320);
    expect(new Set([pos('a').x, pos('b').x, pos('c').x]).size).toBe(3);
    expect(hasOverlap(def, sizes)).toBe(false);
  });

  it('detects overlapping steps', () => {
    const def = { nodes: [node('x', 'LLMNode'), node('y', 'LLMNode')], edges: [] };
    def.nodes[1]!.position = { x: 40, y: 60 };
    expect(hasOverlap(def, new Map())).toBe(true);
    def.nodes[1]!.position = { x: NODE_W + 80, y: 0 };
    expect(hasOverlap(def, new Map())).toBe(false);
  });
});
