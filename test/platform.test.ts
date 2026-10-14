import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileFlow } from '../src/flow/compile.ts';
import { importStudioFlow, parseFlowFile } from '../src/flow/import.ts';
import { MockLLMProvider } from '../src/llm/providers.ts';
import { defaultRegistry } from '../src/nodes/builtin.ts';
import { matches, nextRun, parseCron } from '../src/service/cron.ts';
import { globToRegex } from '../src/service/scheduler.ts';
import { createTestApp } from './helpers.ts';

const trigger = (nodeId = 'graphqlNode', values: Record<string, unknown> = {}) => ({ id: 't', type: 'triggerNode', data: { nodeId, trigger: true, values } });
const respond = (mapping: string) => ({ id: 'r', type: 'responseNode', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: mapping } } });

describe('cron schedules', () => {
  it('parses standard, macro and Quartz-style expressions with time zones', () => {
    const at = (iso: string) => new Date(iso);
    const weekdays9 = parseCron('0 9 * * 1-5');
    expect(matches(weekdays9, at('2026-10-14T09:00:00Z'))).toBe(true);
    expect(matches(weekdays9, at('2026-10-18T09:00:00Z'))).toBe(false);
    expect(matches(parseCron('*/15 * * * *'), at('2026-10-14T10:45:00Z'))).toBe(true);
    expect(matches(parseCron('@hourly'), at('2026-10-14T10:00:00Z'))).toBe(true);
    expect(matches(parseCron('0 0 1 jan,jul *'), at('2026-07-01T00:00:00Z'))).toBe(true);
    // Quartz (seconds first, "?", trailing zone) as used by imported sync triggers.
    expect(matches(parseCron('0 0 00 1/1 * ? * UTC'), at('2026-10-14T00:00:00Z'))).toBe(true);
    const ny = parseCron('30 8 * * *', 'America/New_York');
    expect(matches(ny, at('2026-10-14T12:30:00Z'))).toBe(true);
    expect(nextRun(parseCron('0 0 29 2 *'), at('2026-01-01T00:00:00Z'))?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(nextRun(weekdays9, at('2026-10-16T09:00:00Z'))?.toISOString()).toBe('2026-10-19T09:00:00.000Z');
    expect(() => parseCron('61 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('* * *')).toThrow(/5 fields/);
    expect(() => parseCron('* * * * *', 'Mars/Base')).toThrow(/time zone/);
  });

  it('fires due cron flows once per minute and records schedule state', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('cron', { nodes: [trigger('cronNode', { cronExpression: '*/5 * * * *', cronPayload: '{"kind":"digest"}' }), respond('{"kind": "{{t.output.kind}}", "at": "{{t.output.scheduledAt}}"}')], edges: [{ source: 't', target: 'r' }] });
      expect(await t.app.scheduler.tick(new Date('2026-10-14T10:03:00Z'))).toEqual([]);
      expect(await t.app.scheduler.tick(new Date('2026-10-14T10:05:10Z'))).toEqual(['cron']);
      expect(await t.app.scheduler.tick(new Date('2026-10-14T10:05:40Z'))).toEqual([]);
      await new Promise((r) => setTimeout(r, 50));
      const [run] = t.app.runStore.list({ flowId: 'cron' }).runs;
      expect(run).toMatchObject({ source: 'cron', status: 'success' });
      expect(t.app.runStore.get(run!.id)!.output).toEqual({ kind: 'digest', at: '2026-10-14T10:05:00.000Z' });
      expect(t.app.scheduler.list()).toMatchObject([{ flowId: 'cron', expression: '*/5 * * * *', lastStatus: 'success', lastRunId: run!.id }]);
    } finally {
      await t.close();
    }
  });

  it('syncs a local folder incrementally, one run per new or changed file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jasmine-folder-'));
    const t = await createTestApp();
    try {
      await mkdir(path.join(dir, 'sub'));
      await writeFile(path.join(dir, 'a.md'), '# A\n\nalpha');
      await writeFile(path.join(dir, 'sub', 'b.txt'), 'beta');
      await writeFile(path.join(dir, 'skip.png'), 'png');
      await t.app.deployments.deploy('folder', {
        nodes: [trigger('localFolderNode', { folderPath: dir, globs: ['**/*.{md,txt}'] }), respond('{"key": "{{t.output.document_key}}", "content": "{{t.output.content}}"}')],
        edges: [{ source: 't', target: 'r' }],
      });
      const d = t.app.deployments.getActive('folder')!;
      const values = d.plan.nodes.get('t')!.node.values;
      expect(await t.app.scheduler.syncFolder(d, values)).toHaveLength(2);
      expect(await t.app.scheduler.syncFolder(d, values)).toHaveLength(0);
      await writeFile(path.join(dir, 'a.md'), '# A\n\nalpha v2');
      await utimes(path.join(dir, 'a.md'), new Date(), new Date(Date.now() + 5000));
      const changed = await t.app.scheduler.syncFolder(d, values);
      expect(changed).toHaveLength(1);
      expect(t.app.runStore.get(changed[0]!)!.output).toEqual({ key: 'a.md', content: '# A\n\nalpha v2' });
      expect(globToRegex('**/*.{md,txt}').test('sub/b.txt')).toBe(true);
      expect(globToRegex('*.md').test('sub/a.md')).toBe(false);
    } finally {
      await t.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('run logs and reports', () => {
  it('persists runs with redacted outputs and aggregates them for reports', async () => {
    const t = await createTestApp({ llm: new MockLLMProvider({ respond: () => 'token: sk-abcdefghijklmnop1234' }) });
    try {
      const { app } = t;
      app.project.setSecret('API_TOKEN', 'super-secret-value');
      await app.deployments.deploy('f', {
        nodes: [trigger(), { id: 'l', data: { nodeId: 'LLMNode', values: { prompts: [{ role: 'user', content: 'key={{secrets.project.API_TOKEN}}' }] } } }, respond('{"echo": "{{l.output.generatedResponse}}", "fail": "{{t.output.fail}}"}')],
        edges: [{ source: 't', target: 'l' }, { source: 'l', target: 'r' }],
      });
      await app.runs.executeWorkflow('f', { fail: 1 });
      const failed = await app.runs.executeWorkflow('f', {});
      expect(failed.error?.code).toBe('TEMPLATE_UNRESOLVED');
      const runs = app.runStore.list({ flowId: 'f' });
      expect(runs.runs.map((r) => r.status)).toEqual(['failed', 'success']);
      const ok = app.runStore.get(runs.runs[1]!.id)!;
      expect(JSON.stringify(ok)).not.toContain('sk-abcdefghijklmnop1234');
      expect(JSON.stringify(ok)).not.toContain('super-secret-value');
      expect(ok.models).toEqual(['mock/mock-model']);
      const report = app.runStore.report({ from: new Date(Date.now() - 60_000).toISOString(), bucket: 'hour' });
      expect(report.totals).toMatchObject({ runs: 2, success: 1, failed: 1, llmCalls: 2 });
      expect(report.errors).toMatchObject([{ code: 'TEMPLATE_UNRESOLVED', runs: 1 }]);
      expect(report.byModel).toMatchObject([{ model: 'mock/mock-model', runs: 2 }]);
      expect(report.byFlow).toMatchObject([{ flowId: 'f', runs: 2, failed: 1 }]);
      expect(app.runStore.list({ search: 'TEMPLATE' }).runs).toHaveLength(1);
      expect(app.runStore.prune(1, 0)).toBe(1);
      expect(app.runs.checkStatus(runs.runs[0]!.id).status).toBe('failed');
    } finally {
      await t.close();
    }
  });

  it('marks runs interrupted by a restart as failed', async () => {
    const t = await createTestApp();
    try {
      t.app.runStore.start({ id: 'run-123456', flowId: 'f', version: 'v', source: 'api', mode: 'async', input: {} });
      expect(t.app.runStore.markInterrupted()).toBe(1);
      expect(t.app.runs.checkStatus('run-123456')).toMatchObject({ status: 'failed', error: { code: 'INTERRUPTED' } });
    } finally {
      await t.close();
    }
  });
});

describe('Jasmine export compatibility', () => {
  const registry = defaultRegistry();

  it('passes edges through "+" placeholders (including chains) and drops sticky notes', () => {
    const flow = {
      nodes: [
        { id: 'triggerNode_1', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
        { id: 'addNode_1', type: 'addNode', data: { nodeId: 'addNode', values: { nodeName: '' } } },
        { id: 'plus-node-addNode_2', type: 'addNode', data: { nodeId: 'addNode', values: {} } },
        { id: 'codeNode_1', data: { nodeId: 'codeNode', values: { code: 'output = 1;' } } },
        { id: 'note', type: 'stickyNoteNode', data: { nodeId: 'stickyNoteNode', values: { text: 'hi' } } },
        { id: 'responseNode_1', type: 'responseNode', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"n": {{codeNode_1.output}}}' } } },
      ],
      edges: [
        { source: 'triggerNode_1', target: 'addNode_1', type: 'defaultEdge' }, { source: 'addNode_1', target: 'plus-node-addNode_2', type: 'defaultEdge' },
        { source: 'plus-node-addNode_2', target: 'codeNode_1', type: 'defaultEdge' }, { source: 'codeNode_1', target: 'responseNode_1', type: 'defaultEdge' },
      ],
    };
    const imported = importStudioFlow(flow, { flowId: 'x' });
    expect(imported.definition.nodes.map((n) => n.id)).toEqual(['triggerNode_1', 'codeNode_1', 'responseNode_1']);
    expect(imported.definition.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['codeNode_1>responseNode_1', 'triggerNode_1>codeNode_1']);
    expect(compileFlow(imported.definition, registry).ok).toBe(true);
  });

  it('routes condition edges by label, then by edge id, and treats loop-start condition edges as plain edges', () => {
    const flow = {
      nodes: [
        { id: 'triggerNode_1', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
        { id: 'conditionNode_1', type: 'conditionNode', data: { nodeId: 'conditionNode', values: { conditions: [
          { label: 'Condition 1', value: 'edge-yes', condition: '{"operator":null,"operands":[{"name":"{{triggerNode_1.output.n}}","operator":">","value":"1"}]}' },
          { label: 'Else', value: 'stale-placeholder-value', condition: {} },
        ] } } },
        { id: 'forLoopNode_1', type: 'forLoopNode', data: { nodeId: 'forLoopNode', values: { iterateOver: 'list', iteratorValue: '{{triggerNode_1.output.items}}', connectedTo: 'forLoopEndNode_1' } } },
        { id: 'codeNode_1', data: { nodeId: 'codeNode', values: { code: 'output = {{forLoopNode_1.output.currentValue}} * 10;' } } },
        { id: 'forLoopEndNode_1', type: 'forLoopEndNode', data: { nodeId: 'forLoopEndNode', values: { connectedTo: 'forLoopNode_1' } } },
        { id: 'responseNode_yes', type: 'responseNode', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"r": "{{forLoopEndNode_1.output.loopOutput[:].codeNode_1.output}}"}' } } },
        { id: 'responseNode_no', type: 'responseNode', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"r": "small"}' } } },
      ],
      edges: [
        { id: 'e0', source: 'triggerNode_1', target: 'conditionNode_1', type: 'defaultEdge' },
        { id: 'edge-yes', source: 'conditionNode_1', target: 'forLoopNode_1', type: 'conditionEdge' },
        { id: 'e2', source: 'conditionNode_1', target: 'responseNode_no', type: 'conditionEdge', data: { condition: 'Else' } },
        { id: 'e3', source: 'forLoopNode_1', target: 'codeNode_1', type: 'conditionEdge', data: { condition: 'Loop Start', invisible: true } },
        { id: 'e4', source: 'codeNode_1', target: 'forLoopEndNode_1', type: 'defaultEdge' },
        { id: 'e5', source: 'forLoopNode_1', target: 'forLoopEndNode_1', type: 'loopEdge' },
        { id: 'e6', source: 'forLoopEndNode_1', target: 'forLoopNode_1', type: 'loopEdge', data: { invisible: true } },
        { id: 'e7', source: 'forLoopEndNode_1', target: 'responseNode_yes', type: 'defaultEdge' },
      ],
    };
    const imported = importStudioFlow(flow, { flowId: 'x' });
    expect(imported.diagnostics).toEqual([]);
    const branchOf = (target: string) => imported.definition.edges.find((e) => e.source === 'conditionNode_1' && e.target === target)?.branch;
    expect(branchOf('forLoopNode_1')).toBe('edge-yes');
    expect(branchOf('responseNode_no')).toBe('stale-placeholder-value');
    expect(imported.definition.edges.find((e) => e.source === 'forLoopNode_1' && e.target === 'codeNode_1')?.kind).toBe('default');
    const compiled = compileFlow(imported.definition, registry);
    expect(compiled.ok, JSON.stringify(compiled.diagnostics)).toBe(true);
  });

  it('runs the imported loop/condition flow end to end with Studio-shaped loop output', async () => {
    const t = await createTestApp();
    try {
      const flow = parseFlowFile(`export const nodes = ${JSON.stringify([
        { id: 'triggerNode_1', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
        { id: 'batchNode_1', type: 'batchNode', data: { nodeId: 'batchNode', values: { iterateOver: 'range', initialValue: '0', endValue: '{{triggerNode_1.output.n}}', increment: '1', concurrencyLimit: 3, connectedTo: 'batchEndNode_1' } } },
        { id: 'codeNode_1', data: { nodeId: 'codeNode', values: { code: 'await new Promise((r) => setTimeout(r, 20)); output = {{batchNode_1.output.currentValue}} * 2;' } } },
        { id: 'batchEndNode_1', type: 'batchEndNode', data: { nodeId: 'batchEndNode', values: { connectedTo: 'batchNode_1' } } },
        { id: 'responseNode_1', type: 'responseNode', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"doubled": "{{batchEndNode_1.output.batchOutput[:].codeNode_1.output}}"}' } } },
      ])};\nexport const edges = ${JSON.stringify([
        { source: 'triggerNode_1', target: 'batchNode_1', type: 'defaultEdge' }, { source: 'batchNode_1', target: 'codeNode_1', type: 'conditionEdge' },
        { source: 'codeNode_1', target: 'batchEndNode_1', type: 'defaultEdge' }, { source: 'batchNode_1', target: 'batchEndNode_1', type: 'loopEdge' },
        { source: 'batchEndNode_1', target: 'responseNode_1', type: 'defaultEdge' },
      ])};`);
      await t.app.deployments.deploy('batch', flow);
      const res = await t.app.runs.executeWorkflow('batch', { n: 6 });
      expect(res.output).toEqual({ doubled: [0, 2, 4, 6, 8, 10] });
      // Iterations run in parallel up to the batch's concurrencyLimit (3). Measured from the trace rather than
      // wall-clock time, which mostly reflects worker start-up on slow CI machines.
      const spans = new Map<string, { start: number; end: number }>();
      for (const e of t.app.runs.trace(res.requestId)) {
        if (e.nodeId !== 'codeNode_1') continue;
        const key = (e.iteration ?? []).join('.');
        if (e.type === 'node.start') spans.set(key, { start: e.ts, end: Infinity });
        else if (e.type === 'node.success') spans.get(key)!.end = e.ts;
      }
      expect(spans.size).toBe(6);
      const intervals = [...spans.values()];
      const overlap = Math.max(...intervals.map((a) => intervals.filter((b) => b.start <= a.start && a.start < b.end).length));
      expect(overlap).toBeGreaterThanOrEqual(2);
      expect(overlap).toBeLessThanOrEqual(3);
    } finally {
      await t.close();
    }
  });
});

describe('templates, secrets and flow calls', () => {
  it('evaluates JS expressions, project secrets and variables in templates', async () => {
    const t = await createTestApp();
    try {
      t.app.project.setSecret('TOKEN', 'abc');
      t.app.project.setEnv({ REGION: 'eu' });
      await t.app.deployments.deploy('expr', {
        nodes: [trigger(), respond('{"tier": "{{t.output.score > 7 ? \'gold\' : \'basic\'}}", "fallback": "{{t.output.missing || \'none\'}}", "auth": "Bearer {{secrets.project.TOKEN}}", "region": "{{env.REGION}}"}')],
        edges: [{ source: 't', target: 'r' }],
      });
      expect((await t.app.runs.executeWorkflow('expr', { score: 9 })).output).toEqual({ tier: 'gold', fallback: 'none', auth: 'Bearer abc', region: 'eu' });
      expect((await t.app.runs.executeWorkflow('expr', { score: 2 })).output).toMatchObject({ tier: 'basic' });
      await t.app.deployments.deploy('escape', { nodes: [trigger(), respond('{"x": "{{t.output.constructor.constructor(\'return process\')().env}}"}')], edges: [{ source: 't', target: 'r' }] });
      expect((await t.app.runs.executeWorkflow('escape', {})).error?.code).toBe('TEMPLATE_UNRESOLVED');
    } finally {
      await t.close();
    }
  });

  it('calls other flows with flowNode and stops runaway recursion', async () => {
    const t = await createTestApp();
    try {
      await t.app.deployments.deploy('child', { nodes: [trigger(), respond('{"twice": {{t.output.n}}}')], edges: [{ source: 't', target: 'r' }] });
      await t.app.deployments.deploy('parent', {
        nodes: [trigger(), { id: 'f', data: { nodeId: 'flowNode', values: { flowId: 'child', requestInput: '{"n": {{t.output.n}}}' } } }, respond('{"child": "{{f.output.flowOutput.twice}}"}')],
        edges: [{ source: 't', target: 'f' }, { source: 'f', target: 'r' }],
      });
      expect((await t.app.runs.executeWorkflow('parent', { n: 21 })).output).toEqual({ child: 21 });
      await t.app.deployments.deploy('ping', { nodes: [trigger(), { id: 'f', data: { nodeId: 'flowNode', values: { flowId: 'pong', requestInput: '{}' } } }, respond('{}')], edges: [{ source: 't', target: 'f' }, { source: 'f', target: 'r' }] });
      await t.app.deployments.deploy('pong', { nodes: [trigger(), { id: 'f', data: { nodeId: 'flowNode', values: { flowId: 'ping', requestInput: '{}' } } }, respond('{}')], edges: [{ source: 't', target: 'f' }, { source: 'f', target: 'r' }] });
      const runaway = await t.app.runs.executeWorkflow('ping', {});
      expect(runaway.status).toBe('failed');
      expect(JSON.stringify(t.app.runStore.list({ limit: 100 }).runs.map((r) => r.errorMessage))).toContain('levels deep');
    } finally {
      await t.close();
    }
  });
});
