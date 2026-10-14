import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { EngineError, toEngineError, type ErrorCode } from '../errors.ts';
import type { ExecutionPlan } from '../flow/compile.ts';
import type { NodeEvent, Services } from '../nodes/types.ts';
import { executePlan, type RunResult } from '../runtime/executor.ts';
import { Semaphore } from '../runtime/semaphore.ts';
import { hashValue, type TraceEvent, type TraceOutputMode } from '../runtime/trace.ts';
import type { DeployedVersion, DeploymentRegistry } from './deployments.ts';
import type { RunSource, RunStore } from './runlog.ts';

/** API status values. */
export type ApiStatus = 'success' | 'failed' | 'error' | 'in-progress';

export interface NodeSummary {
  nodeId: string;
  nodeType: string;
  nodeName?: string;
  status: string;
  statusCode: number;
  attempts: number;
  durationMs: number;
  timeTakenInSeconds: number;
  output?: unknown;
  error?: unknown;
}

/**
 * `result` is the flow output on success (what Lamatic-style clients read), or `{ requestId }` while
 * an async run is in progress. The other fields carry the full execution record.
 */
export interface ExecuteResponse {
  status: ApiStatus;
  requestId: string;
  result?: unknown;
  output?: unknown;
  input?: unknown;
  statusCode?: number;
  timeTakenInSeconds?: number;
  version?: string;
  usage?: RunResult['usage'];
  models?: string[];
  nodes?: NodeSummary[];
  error?: { code: ErrorCode | string; message: string; nodeId?: string; retryable: boolean };
  message?: string;
}

export type LiveEvent =
  | { type: 'trace'; event: TraceEvent }
  | { type: 'node'; nodeId: string; event: NodeEvent }
  | { type: 'done'; response: ExecuteResponse };

/** Fan-out of live run events (trace + streamed tokens) to SSE subscribers, with replay for late joiners. */
export class RunEvents {
  private readonly listeners = new Map<string, Set<(e: LiveEvent) => void>>();
  private readonly buffers = new Map<string, LiveEvent[]>();

  subscribe(runId: string, listener: (e: LiveEvent) => void): () => void {
    for (const e of this.buffers.get(runId) ?? []) listener(e);
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  publish(runId: string, event: LiveEvent): void {
    if (event.type !== 'node') {
      const buffer = this.buffers.get(runId) ?? [];
      if (buffer.length < 10_000) buffer.push(event);
      this.buffers.set(runId, buffer);
    }
    for (const l of this.listeners.get(runId) ?? []) l(event);
    if (event.type === 'done') setTimeout(() => this.buffers.delete(runId), 60_000).unref();
  }

  /** Marks a run live from the moment it is accepted, so subscribers wait for a run still queued for a slot. */
  open(runId: string): void {
    if (!this.buffers.has(runId)) this.buffers.set(runId, []);
  }

  isLive(runId: string): boolean {
    return this.buffers.has(runId);
  }
}

export interface RunServiceOptions {
  services: Services;
  maxConcurrentRuns?: number;
  /** Runs waiting for a slot beyond this are rejected with OVERLOADED instead of queueing without bound. */
  maxQueuedRuns?: number;
  realtimeDeadlineMs?: number;
  asyncDeadlineMs?: number;
  nodeConcurrency?: number;
  idempotencyTtlMs?: number;
  retainRuns?: number;
  traceOutputs?: TraceOutputMode;
  store?: RunStore;
  events?: RunEvents;
  /** Max nesting of flows calling flows. */
  maxFlowDepth?: number;
}

interface RunEntry {
  requestId: string;
  workflowId: string;
  version: string;
  payloadHash: string;
  idempotencyRoot: string;
  controller: AbortController;
  promise: Promise<RunResult>;
  result?: RunResult;
  plan: ExecutionPlan;
  draft: boolean;
}

export interface ExecuteOptions {
  idempotencyKey?: string;
  mode?: 'realtime' | 'async';
  signal?: AbortSignal;
  source?: RunSource;
  /** Version to run instead of the active one. */
  version?: string;
  /** Pre-assigned request id, so a caller can subscribe to live events before the run starts. */
  requestId?: string;
}

const depth = new AsyncLocalStorage<number>();

export class RunService {
  private readonly deployments: DeploymentRegistry;
  private readonly opts: Required<Omit<RunServiceOptions, 'traceOutputs' | 'store' | 'events'>> & { traceOutputs: TraceOutputMode; store?: RunStore; events?: RunEvents };
  private readonly runs = new Map<string, RunEntry>();
  private readonly idempotency = new Map<string, { requestId: string; expiresAt: number }>();
  private readonly slots: Semaphore;
  readonly events: RunEvents;

  constructor(deployments: DeploymentRegistry, opts: RunServiceOptions) {
    this.deployments = deployments;
    this.opts = {
      maxConcurrentRuns: 64,
      maxQueuedRuns: 256,
      realtimeDeadlineMs: 120_000,
      asyncDeadlineMs: 20 * 60_000,
      nodeConcurrency: 8,
      idempotencyTtlMs: 24 * 3600_000,
      retainRuns: 2_000,
      traceOutputs: 'hash',
      maxFlowDepth: 5,
      ...opts,
    };
    this.events = opts.events ?? new RunEvents();
    this.slots = new Semaphore(this.opts.maxConcurrentRuns);
    // Flows can call other flows (flowNode, flow tools) through the services.
    this.opts.services = { ...opts.services, invokeFlow: opts.services.invokeFlow ?? ((flowId, payload, signal) => this.invoke(flowId, payload, signal)) };
  }

  get services(): Services {
    return this.opts.services;
  }

  get load() {
    return { active: this.slots.active, queued: this.slots.waiting };
  }

  async executeWorkflow(workflowId: string, payload: unknown, opts: ExecuteOptions = {}): Promise<ExecuteResponse> {
    const deployed = opts.version ? this.deployments.getVersion(workflowId, opts.version) : this.deployments.getActive(workflowId);
    if (!deployed) throw new EngineError('NOT_FOUND', opts.version ? `Version ${opts.version} of ${workflowId} not found` : `Workflow ${workflowId} not found or not deployed`);
    const payloadHash = hashValue(payload ?? {});
    const mode = opts.mode ?? deployed.plan.responseType;

    if (opts.idempotencyKey) {
      const existing = this.lookupIdempotent(workflowId, opts.idempotencyKey);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new EngineError('CONFLICT', 'Idempotency key was already used with a different payload');
        }
        return mode === 'async' && !existing.result ? inProgress(existing) : toResponse(existing, await existing.promise);
      }
    }

    if (opts.requestId && (!/^[A-Za-z0-9-]{8,64}$/.test(opts.requestId) || this.runs.has(opts.requestId))) throw new EngineError('BAD_PAYLOAD', 'Invalid or duplicate request id');
    const entry = this.start({ plan: deployed.plan, draft: false }, payload, payloadHash, mode, opts.requestId ?? randomUUID(), undefined, opts.signal, opts.source ?? 'api');
    if (opts.idempotencyKey) {
      this.idempotency.set(`${workflowId}\u0000${opts.idempotencyKey}`, { requestId: entry.requestId, expiresAt: Date.now() + this.opts.idempotencyTtlMs });
    }
    if (mode === 'async') return inProgress(entry);
    return toResponse(entry, await entry.promise);
  }

  /** Runs an undeployed plan (Studio "Test"); always async so the caller can stream progress. */
  testPlan(plan: ExecutionPlan, payload: unknown, opts: { signal?: AbortSignal } = {}): ExecuteResponse {
    const entry = this.start({ plan, draft: true }, payload, hashValue(payload ?? {}), 'async', randomUUID(), undefined, opts.signal, 'studio', 'preview');
    return inProgress(entry);
  }

  /** Awaits a run started earlier (used by widgets and tests). */
  async wait(requestId: string): Promise<ExecuteResponse> {
    const entry = this.runs.get(requestId);
    if (!entry) return this.checkStatus(requestId);
    return toResponse(entry, await entry.promise);
  }

  checkStatus(requestId: string): ExecuteResponse {
    const entry = this.runs.get(requestId);
    if (entry) return entry.result ? toResponse(entry, entry.result) : inProgress(entry);
    const logged = this.opts.store?.get(requestId);
    if (!logged) throw new EngineError('NOT_FOUND', `Request ${requestId} not found`);
    if (logged.status === 'in-progress') return { status: 'in-progress', requestId, result: { requestId } };
    const status: ApiStatus = logged.status === 'success' ? 'success' : logged.status === 'error' ? 'error' : 'failed';
    const nodes = (Array.isArray(logged.nodes) ? logged.nodes : []) as NodeSummary[];
    return {
      status, requestId, result: logged.output, output: logged.output, input: logged.input, statusCode: logged.statusCode ?? 500,
      timeTakenInSeconds: (logged.durationMs ?? 0) / 1000, version: logged.version, models: logged.models,
      usage: { llmCalls: logged.llmCalls, inputTokens: logged.inputTokens, outputTokens: logged.outputTokens },
      nodes: nodes.map((n) => ({ ...n, timeTakenInSeconds: Math.round(n.durationMs ?? 0) / 1000 })),
      ...(logged.error ? { error: logged.error as ExecuteResponse['error'], message: (logged.error as { message?: string }).message ?? '' } : {}),
    };
  }

  trace(requestId: string): RunResult['trace'] {
    const entry = this.runs.get(requestId);
    if (entry) return structuredClone(entry.result?.trace ?? []);
    const logged = this.opts.store?.get(requestId);
    if (!logged) throw new EngineError('NOT_FOUND', `Request ${requestId} not found`);
    return logged.trace;
  }

  history(workflowId: string): ExecuteResponse[] {
    if (this.opts.store) return this.opts.store.list({ flowId: workflowId, limit: 100 }).runs.map((r) => this.checkStatus(r.id));
    return [...this.runs.values()].filter((entry) => entry.workflowId === workflowId).reverse().map((entry) => entry.result ? toResponse(entry, entry.result) : inProgress(entry));
  }

  /** Retry from the failed node: same version, same input, successful nodes reused (not re-run). */
  async retryWorkflow(requestId: string): Promise<ExecuteResponse> {
    const prior = this.runs.get(requestId);
    if (!prior) throw new EngineError('NOT_FOUND', `Request ${requestId} is no longer in memory; run it again instead`);
    if (!prior.result) throw new EngineError('CONFLICT', `Request ${requestId} is still in progress`);
    if (prior.result.status === 'success') return toResponse(prior, prior.result);
    const plan = prior.draft ? prior.plan : this.deployments.getVersion(prior.workflowId, prior.version)?.plan;
    if (!plan) throw new EngineError('NOT_FOUND', `Version ${prior.version} of ${prior.workflowId} is no longer available`);
    const entry = this.start({ plan, draft: prior.draft }, prior.result.input, prior.payloadHash, 'realtime', randomUUID(), prior, undefined, 'retry');
    return toResponse(entry, await entry.promise);
  }

  cancel(requestId: string): boolean {
    const entry = this.runs.get(requestId);
    if (!entry || entry.result) return false;
    entry.controller.abort();
    return true;
  }

  /** Flow-to-flow calls run realtime, inherit cancellation, and are bounded in depth. */
  private async invoke(flowId: string, payload: unknown, signal: AbortSignal) {
    const level = depth.getStore() ?? 0;
    if (level >= this.opts.maxFlowDepth) throw new EngineError('LOOP_LIMIT', `Flows may call other flows at most ${this.opts.maxFlowDepth} levels deep`);
    const res = await this.executeWorkflow(flowId, payload, { mode: 'realtime', signal, source: 'flow' });
    return { status: res.status, output: res.output, ...(res.error ? { error: { message: res.error.message } } : {}) };
  }

  private start(
    target: { plan: ExecutionPlan; draft: boolean },
    payload: unknown,
    payloadHash: string,
    mode: 'realtime' | 'async',
    requestId: string,
    prior: RunEntry | undefined,
    signal: AbortSignal | undefined,
    source: RunSource,
    traceOutputs: TraceOutputMode = this.opts.traceOutputs,
  ): RunEntry {
    // A nested run (a Run Flow node or flow tool calling another flow) executes inside its parent's slot.
    // Taking a second slot could deadlock once every slot is held by a parent waiting on its child;
    // maxFlowDepth bounds how deep nesting goes.
    const level = depth.getStore() ?? 0;
    const nested = level > 0;
    if (!nested && this.slots.active >= this.opts.maxConcurrentRuns && this.slots.waiting >= this.opts.maxQueuedRuns) {
      throw new EngineError('OVERLOADED', 'Too many runs in flight; retry later', { retryable: true });
    }
    const plan = target.plan;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const entry: RunEntry = {
      requestId,
      workflowId: plan.flowId,
      version: plan.version,
      payloadHash,
      idempotencyRoot: prior?.idempotencyRoot ?? requestId,
      controller,
      promise: Promise.resolve(undefined as unknown as RunResult),
      plan,
      draft: target.draft,
    };
    this.opts.store?.start({ id: requestId, flowId: plan.flowId, version: plan.version, source, mode, input: payload, retryOf: prior?.requestId });
    this.events.open(requestId);
    entry.promise = depth.run(level + 1, async () => {
      const t0 = Date.now();
      if (!nested) {
        await this.slots.acquire(controller.signal).catch((e) => {
          throw toEngineError(e);
        });
      }
      try {
        const deadlineMs = (mode === 'async' ? this.opts.asyncDeadlineMs : this.opts.realtimeDeadlineMs) - (Date.now() - t0);
        // The plan object was captured at request time: a deploy that lands mid-run cannot change this run.
        return await executePlan(plan, {
          payload,
          services: this.opts.services,
          runId: requestId,
          idempotencyRoot: entry.idempotencyRoot,
          concurrency: this.opts.nodeConcurrency,
          deadlineMs: Math.max(deadlineMs, 1),
          signal: controller.signal,
          traceOutputs,
          onEvent: (event) => this.events.publish(requestId, { type: 'trace', event }),
          onNodeEvent: (nodeId, event) => this.events.publish(requestId, { type: 'node', nodeId, event }),
          ...(prior?.result ? { previous: prior.result } : {}),
        });
      } finally {
        if (!nested) this.slots.release();
      }
    }).then(
      (result) => (entry.result = result),
      (err) => (entry.result = syntheticFailure(entry, payload, toEngineError(err))),
    ).then((result) => {
      const response = toResponse(entry, result);
      try {
        this.opts.store?.finish(result, result.error?.code === 'CANCELLED' ? 'cancelled' : response.status === 'in-progress' ? 'failed' : response.status);
      } catch {
        /* logging must never fail a run */
      }
      this.events.publish(requestId, { type: 'done', response });
      return result;
    });
    entry.promise = entry.promise.finally(() => signal?.removeEventListener('abort', onAbort));
    this.runs.set(requestId, entry);
    this.evict();
    return entry;
  }

  private lookupIdempotent(workflowId: string, key: string): RunEntry | undefined {
    const k = `${workflowId}\u0000${key}`;
    const hit = this.idempotency.get(k);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
      this.idempotency.delete(k);
      return undefined;
    }
    return this.runs.get(hit.requestId);
  }

  private evict() {
    if (this.runs.size <= this.opts.retainRuns) return;
    for (const [id, entry] of this.runs) {
      if (this.runs.size <= this.opts.retainRuns) break;
      if (entry.result) this.runs.delete(id);
    }
  }
}

function syntheticFailure(entry: RunEntry, payload: unknown, err: EngineError): RunResult {
  return {
    runId: entry.requestId,
    flowId: entry.workflowId,
    version: entry.version,
    status: 'failed',
    statusCode: err.code === 'OVERLOADED' ? 429 : 500,
    input: payload,
    output: undefined,
    error: err.toJSON(),
    nodes: {},
    usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0 },
    models: [],
    timeTakenMs: 0,
    trace: [],
  };
}

function inProgress(entry: RunEntry): ExecuteResponse {
  return { status: 'in-progress', requestId: entry.requestId, result: { requestId: entry.requestId } };
}

export function toResponse(entry: { requestId: string; plan?: ExecutionPlan }, run: RunResult): ExecuteResponse {
  const status: ApiStatus = run.status === 'success' ? 'success' : run.error?.code === 'INTERNAL' ? 'error' : 'failed';
  const names = (id: string) => entry.plan?.nodes.get(id)?.node.name;
  return {
    status,
    requestId: entry.requestId,
    result: run.output,
    output: run.output,
    input: run.input,
    statusCode: run.statusCode,
    timeTakenInSeconds: Math.round(run.timeTakenMs) / 1000,
    version: run.version,
    usage: run.usage,
    models: run.models,
    nodes: Object.values(run.nodes).map((n) => {
      const name = names(n.nodeId);
      return {
        nodeId: n.nodeId, nodeType: n.nodeType, ...(name ? { nodeName: name } : {}), status: n.status, statusCode: n.statusCode, attempts: n.attempts,
        durationMs: Math.round(n.durationMs), timeTakenInSeconds: Math.round(n.durationMs) / 1000,
        ...(n.error ? { error: n.error } : {}),
      };
    }),
    ...(run.error ? { error: run.error, message: run.error.message } : {}),
  };
}
