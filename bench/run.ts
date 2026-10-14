/**
 * Reproducible benchmarks for Jasmine. Every comparison is between two configurations of THIS engine;
 * nothing here measures a hosted service. LLM latency is simulated with a seeded RNG.
 *
 *   node bench/run.ts            # full run, writes bench/results/latest.json
 *   node bench/run.ts --quick    # fewer iterations
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { compileFlow, type ExecutionPlan } from '../src/flow/compile.ts';
import type { FlowEdge, FlowNode } from '../src/flow/schema.ts';
import { MockLLMProvider, StaticLLMRouter } from '../src/llm/providers.ts';
import { defaultRegistry } from '../src/nodes/builtin.ts';
import type { Services } from '../src/nodes/types.ts';
import { executePlan } from '../src/runtime/executor.ts';
import { DeploymentRegistry } from '../src/service/deployments.ts';
import { RunService } from '../src/service/runs.ts';

const QUICK = process.argv.includes('--quick');
const RUNS = QUICK ? 20 : 100;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { n: s.length, mean: r(mean), p50: r(pct(50)), p95: r(pct(95)), p99: r(pct(99)), min: r(s[0]!), max: r(s[s.length - 1]!) };
}

function services(seed: number, minMs = 15, maxMs = 35): Services {
  const rand = mulberry32(seed);
  const llm = new MockLLMProvider({ latencyMs: () => minMs + rand() * (maxMs - minMs), respond: () => 'ok' });
  return { llm: new StaticLLMRouter({ mock: llm }, 'mock', 'mock-model'), fetch: globalThis.fetch, codeTimeoutMs: 1000 };
}

const T: FlowNode = { id: 'trigger', type: 'graphqlNode', trigger: true, values: {} };
const llm = (id: string, prompt = 'q'): FlowNode => ({ id, type: 'LLMNode', trigger: false, values: { prompts: [{ role: 'user', content: prompt }] } });
const code = (id: string, src: string): FlowNode => ({ id, type: 'codeNode', trigger: false, values: { code: src } });
const resp = (mapping: string): FlowNode => ({ id: 'response', type: 'graphqlResponseNode', trigger: false, values: { outputMapping: mapping } });
const e = (source: string, target: string): FlowEdge => ({ source, target, kind: 'default' });

function compileOrDie(nodes: FlowNode[], edges: FlowEdge[]): ExecutionPlan {
  const r = compileFlow({ id: 'bench', nodes, edges }, defaultRegistry(), { maxRecommendedNodes: 10_000 });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.plan;
}

/** Shapes taken from common Studio export kit patterns. */
const FLOWS: Record<string, () => ExecutionPlan> = {
  // Prompt chain: no independent work, so parallel scheduling must not regress it.
  'chain-5 (sequential prompt chain)': () => {
    const ids = ['l1', 'l2', 'l3', 'l4', 'l5'];
    return compileOrDie([T, ...ids.map((id, i) => llm(id, i ? `{{${ids[i - 1]}.output.generatedResponse}}` : 'q')), resp('{"a":"{{l5.output.generatedResponse}}"}')],
      [e('trigger', 'l1'), ...ids.slice(1).map((id, i) => e(ids[i]!, id)), e('l5', 'response')]);
  },
  // Multi-query / multi-aspect analysis: N independent LLM calls, then a merge.
  'fanout-6 (parallel analyses + merge)': () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    return compileOrDie([T, ...ids.map((id) => llm(id)), code('merge', `output = [${ids.map((id) => `{{${id}.output.generatedResponse}}`).join(',')}].length;`), resp('{"n":"{{merge.output}}"}')],
      [...ids.map((id) => e('trigger', id)), ...ids.map((id) => e(id, 'merge')), e('merge', 'response')]);
  },
  // Three independent 2-step branches (e.g. extract -> classify per document type), joined at the end.
  'branches-3x2 (independent sub-pipelines)': () => {
    const nodes: FlowNode[] = [T];
    const edges: FlowEdge[] = [];
    for (const b of ['x', 'y', 'z']) {
      nodes.push(llm(`${b}1`), llm(`${b}2`, `{{${b}1.output.generatedResponse}}`));
      edges.push(e('trigger', `${b}1`), e(`${b}1`, `${b}2`), e(`${b}2`, 'join'));
    }
    nodes.push(code('join', 'output = 1;'), resp('{"ok":"{{join.output}}"}'));
    edges.push(e('join', 'response'));
    return compileOrDie(nodes, edges);
  },
};

async function timeRuns(plan: ExecutionPlan, concurrency: number, seed: number, n: number) {
  const svc = services(seed);
  for (let i = 0; i < 3; i++) await executePlan(plan, { payload: {}, services: svc, concurrency });
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await executePlan(plan, { payload: {}, services: svc, concurrency });
    if (res.status !== 'success') throw new Error(`bench run failed: ${JSON.stringify(res.error)}`);
    samples.push(res.timeTakenMs);
  }
  return stats(samples);
}

async function benchScheduling() {
  const rows: Record<string, unknown>[] = [];
  for (const [name, make] of Object.entries(FLOWS)) {
    const plan = make();
    const seq = await timeRuns(plan, 1, 42, RUNS);
    const par = await timeRuns(plan, 8, 42, RUNS);
    rows.push({ flow: name, sequential: seq, parallel: par, p50Speedup: Math.round((seq.p50 / par.p50) * 100) / 100 });
  }
  return rows;
}

/** Engine-only cost: zero-latency nodes, so all time is scheduling, templating, tracing. */
async function benchOverhead() {
  const rows: Record<string, unknown>[] = [];
  const zero: Services = { llm: new StaticLLMRouter({ mock: new MockLLMProvider() }, 'mock', 'm'), fetch: globalThis.fetch, codeTimeoutMs: 1000 };
  for (const size of [10, 50, 200]) {
    for (const shape of ['chain', 'wide'] as const) {
      const ids = Array.from({ length: size }, (_, i) => `v${i}`);
      const nodes: FlowNode[] = [T, ...ids.map((id) => ({ id, type: 'variablesNode', trigger: false, values: { mapping: '{"x":{"type":"number","value":"1"}}' } })), resp('{}')];
      const edges: FlowEdge[] = shape === 'chain'
        ? [e('trigger', 'v0'), ...ids.slice(1).map((id, i) => e(ids[i]!, id)), e(ids[size - 1]!, 'response')]
        : [...ids.map((id) => e('trigger', id)), ...ids.map((id) => e(id, 'response'))];
      const plan = compileOrDie(nodes, edges);
      for (let i = 0; i < 5; i++) await executePlan(plan, { payload: {}, services: zero });
      const samples: number[] = [];
      const iterations = QUICK ? 30 : 150;
      for (let i = 0; i < iterations; i++) samples.push((await executePlan(plan, { payload: {}, services: zero })).timeTakenMs);
      const s = stats(samples);
      rows.push({ shape, nodes: size + 2, ...s, perNodeUs: Math.round((s.p50 / (size + 2)) * 1000) });
    }
  }
  return rows;
}

async function benchCompile() {
  const rows: Record<string, unknown>[] = [];
  for (const size of [20, 50, 200]) {
    const ids = Array.from({ length: size }, (_, i) => `n${i}`);
    const rand = mulberry32(size);
    const nodes: FlowNode[] = [T, ...ids.map((id, i) => llm(id, i > 0 ? `{{${ids[Math.floor(rand() * i)]}.output.generatedResponse}}` : 'q')), resp('{}')];
    const edges: FlowEdge[] = [e('trigger', 'n0')];
    for (let i = 1; i < size; i++) {
      const refd = nodes[i + 1]!.values['prompts'] as { content: string }[];
      const parent = /\{\{(n\d+)\./.exec(refd[0]!.content)![1]!;
      edges.push(e(parent, ids[i]!));
      if (rand() < 0.3 && i > 1) edges.push(e(ids[Math.floor(rand() * i)]!, ids[i]!));
    }
    for (const id of ids) if (!edges.some((x) => x.source === id)) edges.push(e(id, 'response'));
    const def = { nodes, edges };
    const iterations = QUICK ? 20 : 100;

    const cold: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const r = compileFlow({ id: 'c', ...def }, defaultRegistry(), { maxRecommendedNodes: 10_000 });
      cold.push(performance.now() - t0);
      if (!r.ok) throw new Error(JSON.stringify(r.diagnostics.slice(0, 3)));
    }
    const reg = new DeploymentRegistry(defaultRegistry());
    const cached: number[] = [];
    await reg.deploy('c', def);
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      await reg.deploy('c', def);
      cached.push(performance.now() - t0);
    }
    rows.push({ nodes: size + 2, coldCompileMs: stats(cold), unchangedRedeployMs: stats(cached), compiles: reg.stats.compiles, cacheHits: reg.stats.cacheHits });
  }
  return rows;
}

async function benchThroughput() {
  const rows: Record<string, unknown>[] = [];
  const total = QUICK ? 60 : 300;
  const clients = 50;
  for (const nodeConcurrency of [1, 8]) {
    const deployments = new DeploymentRegistry(defaultRegistry());
    const runs = new RunService(deployments, { services: services(7), nodeConcurrency, maxConcurrentRuns: 64, maxQueuedRuns: 10_000 });
    const plan = FLOWS['fanout-6 (parallel analyses + merge)']!();
    await deployments.deploy('fan', plan.definition);
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const latencies: number[] = [];
    let next = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: clients }, async () => {
      while (next < total) {
        next++;
        const s = performance.now();
        const res = await runs.executeWorkflow('fan', {});
        if (res.status !== 'success') throw new Error(JSON.stringify(res.error));
        latencies.push(performance.now() - s);
      }
    }));
    const wall = (performance.now() - t0) / 1000;
    rows.push({
      nodeConcurrency,
      clients,
      runs: total,
      runsPerSecond: Math.round((total / wall) * 10) / 10,
      latencyMs: stats(latencies),
      heapDeltaMB: Math.round(((process.memoryUsage().heapUsed - heapBefore) / 1e6) * 10) / 10,
    });
    await sleep(10);
  }
  return rows;
}

async function benchRetryAmplification() {
  // Measured: calls the engine makes for one node with 3 attempts against an always-503 provider.
  const { EngineError } = await import('../src/errors.ts');
  const failing = new MockLLMProvider({ fail: () => new EngineError('PROVIDER', '503', { retryable: true }) });
  const svc: Services = { llm: new StaticLLMRouter({ mock: failing }, 'mock', 'm'), fetch: globalThis.fetch, codeTimeoutMs: 1000 };
  const plan = compileOrDie([T, { ...llm('l'), logic: { retry: { maxAttempts: 3, delayMs: 0, backoff: 'fixed', jitter: false } } }, resp('{}')], [e('trigger', 'l'), e('l', 'response')]);
  await executePlan(plan, { payload: {}, services: svc });
  return {
    measuredProviderCallsPerFailedNode: failing.calls,
    note: 'Single retry layer: SDK maxRetries=0, node policy owns retries.',
    stackedLayersArithmetic: { sdkDefaultAttempts: 3, nodeAttempts: 3, flowLevelRetriesMax: 5, worstCaseCalls: 3 * 3 * (1 + 5) },
  };
}

const env = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  cpu: `${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}`,
  memoryGB: Math.round(os.totalmem() / 1e9),
  quick: QUICK,
  runsPerCell: RUNS,
  simulatedLlmLatencyMs: 'uniform 15-35 (seeded)',
};

console.log('environment', env);
const results = {
  env,
  scheduling: await benchScheduling(),
  engineOverhead: await benchOverhead(),
  compile: await benchCompile(),
  throughput: await benchThroughput(),
  retryAmplification: await benchRetryAmplification(),
};
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./results/${QUICK ? 'quick' : 'latest'}.json`, import.meta.url), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
