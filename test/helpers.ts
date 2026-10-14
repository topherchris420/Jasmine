import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Jasmine, type JasmineConfig } from '../src/app.ts';
import { createServer, type ServerOptions } from '../src/api/server.ts';
import type { LLMProvider } from '../src/llm/types.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { EngineError, type ErrorCode } from '../src/errors.ts';
import { compileFlow, type ExecutionPlan } from '../src/flow/compile.ts';
import type { FlowEdge, FlowNode } from '../src/flow/schema.ts';
import { resolveValue } from '../src/flow/template.ts';
import { MockLLMProvider, StaticLLMRouter } from '../src/llm/providers.ts';
import { defaultRegistry } from '../src/nodes/builtin.ts';
import type { NodeRegistry, Services } from '../src/nodes/types.ts';

export function makeServices(llm = new MockLLMProvider(), fetchImpl: typeof fetch = globalThis.fetch): Services {
  return { llm: new StaticLLMRouter({ mock: llm }, 'mock', 'mock-model'), fetch: fetchImpl, codeTimeoutMs: 1000 };
}

export interface ProbeLog {
  calls: Map<string, number>;
  /** Monotonic sequence of start/end events, for ordering checks. */
  timeline: { id: string; kind: 'start' | 'end' }[];
  active: number;
  maxActive: number;
  aborted: Set<string>;
  keys: Map<string, string[]>;
}

export const newLog = (): ProbeLog => ({ calls: new Map(), timeline: [], active: 0, maxActive: 0, aborted: new Set(), keys: new Map() });

/**
 * Default registry plus two test node types:
 *  - probe: sleeps `delayMs`, fails the first `failTimes` attempts with `errorCode`, echoes `value`.
 *  - gate:  a condition node whose active branch is `pick` ("yes" | "no").
 */
export function testRegistry(log: ProbeLog = newLog()): NodeRegistry {
  const reg = defaultRegistry();
  reg.register({
    type: 'probe',
    kind: 'action',
    sideEffect: (n) => n.values['sideEffect'] === true,
    idempotent: (n) => n.values['idempotent'] === true || n.values['sideEffect'] !== true,
    async run(ctx) {
      log.calls.set(ctx.nodeId, (log.calls.get(ctx.nodeId) ?? 0) + 1);
      log.keys.set(ctx.nodeId, [...(log.keys.get(ctx.nodeId) ?? []), ctx.idempotencyKey]);
      log.timeline.push({ id: ctx.nodeId, kind: 'start' });
      log.active++;
      log.maxActive = Math.max(log.maxActive, log.active);
      try {
        const delay = Number(ctx.values['delayMs'] ?? 0);
        if (delay > 0) {
          try {
            await sleep(delay, undefined, { signal: ctx.signal });
          } catch (e) {
            log.aborted.add(ctx.nodeId);
            throw e;
          }
        }
        if (ctx.attempt <= Number(ctx.values['failTimes'] ?? 0)) {
          throw new EngineError((ctx.values['errorCode'] as ErrorCode) ?? 'UPSTREAM_HTTP', `injected failure on attempt ${ctx.attempt}`, {
            retryable: ctx.values['retryable'] !== false,
          });
        }
        const value = resolveValue(ctx.values['value'], ctx.scope, { strict: ctx.strictTemplates, nodeId: ctx.nodeId });
        return { output: { id: ctx.nodeId, attempt: ctx.attempt, value } };
      } finally {
        log.active--;
        log.timeline.push({ id: ctx.nodeId, kind: 'end' });
      }
    },
  });
  reg.register({
    type: 'gate',
    kind: 'condition',
    branchKeys: () => ['yes', 'no'],
    async run(ctx) {
      const pick = String(ctx.values['pick'] ?? 'yes');
      return { output: { condition: pick }, branches: [pick] };
    },
  });
  return reg;
}

export const trigger = (values: Record<string, unknown> = {}): FlowNode => ({ id: 'trigger', type: 'graphqlNode', trigger: true, values });
export const response = (mapping: string, id = 'response'): FlowNode => ({ id, type: 'graphqlResponseNode', trigger: false, values: { outputMapping: mapping } });
export const probe = (id: string, values: Record<string, unknown> = {}, logic?: FlowNode['logic']): FlowNode => ({
  id, type: 'probe', trigger: false, values, ...(logic ? { logic } : {}),
});
export const edge = (source: string, target: string, branch?: string): FlowEdge =>
  branch ? { source, target, kind: 'condition', branch } : { source, target, kind: 'default' };

export function plan(nodes: FlowNode[], edges: FlowEdge[], registry: NodeRegistry = testRegistry()): ExecutionPlan {
  const result = compileFlow({ id: 'flow', nodes, edges }, registry);
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics, null, 2)}`);
  return result.plan;
}

/** A Studio export in the exact shape of the public AgentKit "article-summariser" flow (scraper swapped for apiNode). */
export function studioArticleSummariser() {
  return {
    meta: { name: 'Article Summariser' },
    nodes: [
      { id: 'triggerNode_1', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: { nodeName: 'API Request', responeType: 'realtime', advance_schema: '' } } },
      { id: 'apiNode_252', type: 'dynamicNode', data: { nodeId: 'apiNode', values: { nodeName: 'Fetch', url: '{{triggerNode_1.output.url}}', method: 'GET', headers: '', body: '', retries: '2', retry_delay: '0' } } },
      { id: 'LLMNode_160', type: 'dynamicNode', data: { nodeId: 'LLMNode', values: { nodeName: 'Generate Text', tools: [], prompts: [
        { id: 'p1', role: 'system', content: 'Summarise the article.' },
        { id: 'p2', role: 'user', content: '{{apiNode_252.output}}' },
      ], generativeModelName: [{ provider_name: 'mock', model_name: 'mock-model' }] } } },
      { id: 'graphqlResponseNode_651', type: 'dynamicNode', data: { nodeId: 'graphqlResponseNode', values: { nodeName: 'API Response', outputMapping: '{\n  "summary": "{{LLMNode_160.output.generatedResponse}}"\n}' } } },
      { id: 'addNode_9', type: 'addNode', data: { nodeId: 'addNode', values: {} } },
    ],
    edges: [
      { id: 'e1', source: 'triggerNode_1', target: 'apiNode_252', sourceHandle: 'bottom', targetHandle: 'top', type: 'defaultEdge' },
      { id: 'e2', source: 'apiNode_252', target: 'LLMNode_160', sourceHandle: 'bottom', targetHandle: 'top', type: 'defaultEdge' },
      { id: 'e3', source: 'LLMNode_160', target: 'graphqlResponseNode_651', sourceHandle: 'bottom', targetHandle: 'top', type: 'defaultEdge' },
      { id: 'e4', source: 'triggerNode_1', target: 'graphqlResponseNode_651', sourceHandle: 'to-response', targetHandle: 'from-trigger', type: 'responseEdge' },
      { id: 'e5', source: 'graphqlResponseNode_651', target: 'addNode_9', sourceHandle: 'bottom', targetHandle: 'top', type: 'defaultEdge' },
    ],
  };
}

export function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

/* ---------------- full-app helpers ---------------- */


export interface TestApp {
  app: Jasmine;
  dataDir: string;
  close(): Promise<void>;
}

/** A complete Jasmine with an in-memory database and a deterministic mock model. */
export async function createTestApp(config: Partial<JasmineConfig> & { llm?: LLMProvider } = {}): Promise<TestApp> {
  const dataDir = config.dataDir ?? await mkdtemp(path.join(os.tmpdir(), 'jasmine-test-'));
  const { llm, ...rest } = config;
  const app = await Jasmine.create({ dataDir, inMemory: true, env: { LLM_PROVIDER: 'mock' }, probeModels: false, scheduler: false, seed: false, codeTimeoutMs: 2000, ...rest });
  if (llm) {
    app.llm.setConnections([
      { id: 'mock', name: 'Mock', kind: 'mock', provider: llm, chatModel: 'mock-model', embeddingModel: 'mock-embed' },
      ...app.llm.list().filter((c) => c.id !== 'mock'),
    ], { defaultChat: 'mock', defaultEmbedding: 'mock' });
  }
  return {
    app, dataDir,
    async close() {
      await app.close();
      if (!config.dataDir) await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export async function withHttp(app: Jasmine, run: (base: string) => Promise<void>, opts: ServerOptions = {}): Promise<void> {
  const server = createServer(app, opts).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

export const jsonRequest = (base: string, headers: Record<string, string> = {}) => async (url: string, method = 'GET', body?: unknown) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, data: data as any, headers: res.headers };
};

/** Reads a server-sent-events response into [event, data] pairs. */
export async function readEvents(res: Response): Promise<[string, any][]> {
  const text = await res.text();
  return text.split('\n\n').filter((b) => b.startsWith('event:')).map((block) => {
    const event = /^event: (.*)$/m.exec(block)![1]!;
    const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]!);
    return [event, data];
  });
}
