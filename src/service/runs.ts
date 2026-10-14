import { randomUUID } from 'node:crypto';
import { EngineError, toEngineError, type ErrorCode } from '../errors.ts';
import type { Services } from '../nodes/types.ts';
import { executePlan, type RunResult } from '../runtime/executor.ts';
import { Semaphore } from '../runtime/semaphore.ts';
import { hashValue, type TraceOutputMode } from '../runtime/trace.ts';
import type { DeployedVersion, DeploymentRegistry } from './deployments.ts';

/** Jasmine API status values. */
export type ApiStatus = 'success' | 'failed' | 'error' | 'in-progress';

export interface ExecuteResponse {
  status: ApiStatus;
  requestId: string;
  result?: {
    input: unknown;
    output: unknown;
    statusCode: number;
    timeTakenInSeconds: number;
    version: string;
    usage: RunResult['usage'];
    nodes: { nodeId: string; nodeType: string; status: string; statusCode: number; attempts: number; durationMs: number; error?: unknown }[];
  };
  error?: { code: ErrorCode; message: string; nodeId?: string; retryable: boolean };
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
}

export class RunService {
  private readonly deployments: DeploymentRegistry;
  private readonly opts: Required<Omit<RunServiceOptions, 'traceOutputs'>> & { traceOutputs: TraceOutputMode };
  private readonly runs = new Map<string, RunEntry>();
  private readonly idempotency = new Map<string, { requestId: string; expiresAt: number }>();
  private readonly slots: Semaphore;

  constructor(deployments: DeploymentRegistry, opts: RunServiceOptions) {
    this.deployments = deployments;
    this.opts = {
      maxConcurrentRuns: 64,
      maxQueuedRuns: 256,
      realtimeDeadlineMs: 120_000,
      asyncDeadlineMs: 20 * 60_000,
      nodeConcurrency: 8,
      idempotencyTtlMs: 24 * 3600_000,
      retainRuns: 10_000,
      traceOutputs: 'hash',
      ...opts,
    };
    this.slots = new Semaphore(this.opts.maxConcurrentRuns);
  }

  get load() {
    return { active: this.slots.active, queued: this.slots.waiting };
  }

  async executeWorkflow(
    workflowId: string,
    payload: unknown,
    opts: { idempotencyKey?: string; mode?: 'realtime' | 'async'; signal?: AbortSignal } = {},
  ): Promise<ExecuteResponse> {
    const deployed = this.deployments.getActive(workflowId);
    if (!deployed) throw new EngineError('NOT_FOUND', `Workflow ${workflowId} not found`);
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

    const entry = this.start(deployed, payload, payloadHash, mode, randomUUID(), undefined, opts.signal);
    if (opts.idempotencyKey) {
      this.idempotency.set(`${workflowId}\u0000${opts.idempotencyKey}`, { requestId: entry.requestId, expiresAt: Date.now() + this.opts.idempotencyTtlMs });
    }
    if (mode === 'async') return inProgress(entry);
    return toResponse(entry, await entry.promise);
  }

  checkStatus(requestId: string): ExecuteResponse {
    const entry = this.runs.get(requestId);
    if (!entry) throw new EngineError('NOT_FOUND', `Request ${requestId} not found`);
    return entry.result ? toResponse(entry, entry.result) : inProgress(entry);
  }

  trace(requestId: string): RunResult['trace'] {
    const entry = this.runs.get(requestId);
    if (!entry) throw new EngineError('NOT_FOUND', `Request ${requestId} not found`);
    return structuredClone(entry.result?.trace ?? []);
  }

  history(workflowId: string): ExecuteResponse[] {
    return [...this.runs.values()].filter((entry) => entry.workflowId === workflowId).reverse().map((entry) => entry.result ? toResponse(entry, entry.result) : inProgress(entry));
  }

  /** Retry from the failed node: same version, same input, successful nodes reused (not re-run). */
  async retryWorkflow(requestId: string): Promise<ExecuteResponse> {
    const prior = this.runs.get(requestId);
    if (!prior) throw new EngineError('NOT_FOUND', `Request ${requestId} not found`);
    if (!prior.result) throw new EngineError('CONFLICT', `Request ${requestId} is still in progress`);
    if (prior.result.status === 'success') return toResponse(prior, prior.result);
    const deployed = this.deployments.getVersion(prior.workflowId, prior.version);
    if (!deployed) throw new EngineError('NOT_FOUND', `Version ${prior.version} of ${prior.workflowId} is no longer available`);
    const entry = this.start(deployed, prior.result.input, prior.payloadHash, 'realtime', randomUUID(), prior);
    return toResponse(entry, await entry.promise);
  }

  cancel(requestId: string): boolean {
    const entry = this.runs.get(requestId);
    if (!entry || entry.result) return false;
    entry.controller.abort();
    return true;
  }

  private start(
    deployed: DeployedVersion,
    payload: unknown,
    payloadHash: string,
    mode: 'realtime' | 'async',
    requestId: string,
    prior: RunEntry | undefined,
    signal?: AbortSignal,
  ): RunEntry {
    if (this.slots.active >= this.opts.maxConcurrentRuns && this.slots.waiting >= this.opts.maxQueuedRuns) {
      throw new EngineError('OVERLOADED', 'Too many runs in flight; retry later', { retryable: true });
    }
    const controller = new AbortController();
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    const entry: RunEntry = {
      requestId,
      workflowId: deployed.flowId,
      version: deployed.version,
      payloadHash,
      idempotencyRoot: prior?.idempotencyRoot ?? requestId,
      controller,
      promise: Promise.resolve(undefined as unknown as RunResult),
    };
    entry.promise = (async () => {
      const t0 = Date.now();
      await this.slots.acquire(controller.signal).catch((e) => {
        throw toEngineError(e);
      });
      try {
        const deadlineMs = (mode === 'async' ? this.opts.asyncDeadlineMs : this.opts.realtimeDeadlineMs) - (Date.now() - t0);
        // The plan object was captured at request time: a deploy that lands mid-run cannot change this run.
        return await executePlan(deployed.plan, {
          payload,
          services: this.opts.services,
          runId: requestId,
          idempotencyRoot: entry.idempotencyRoot,
          concurrency: this.opts.nodeConcurrency,
          deadlineMs: Math.max(deadlineMs, 1),
          signal: controller.signal,
          traceOutputs: this.opts.traceOutputs,
          ...(prior?.result ? { previous: prior.result } : {}),
        });
      } finally {
        this.slots.release();
      }
    })().then(
      (result) => (entry.result = result),
      (err) => (entry.result = syntheticFailure(entry, payload, toEngineError(err))),
    );
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
    statusCode: 500,
    input: payload,
    output: undefined,
    error: err.toJSON(),
    nodes: {},
    usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0 },
    timeTakenMs: 0,
    trace: [],
  };
}

function inProgress(entry: RunEntry): ExecuteResponse {
  return { status: 'in-progress', requestId: entry.requestId };
}

function toResponse(entry: RunEntry, run: RunResult): ExecuteResponse {
  const status: ApiStatus = run.status === 'success' ? 'success' : run.error?.code === 'INTERNAL' ? 'error' : 'failed';
  return {
    status,
    requestId: entry.requestId,
    result: {
      input: run.input,
      output: run.output,
      statusCode: run.statusCode,
      timeTakenInSeconds: Math.round(run.timeTakenMs) / 1000,
      version: run.version,
      usage: run.usage,
      nodes: Object.values(run.nodes).map((n) => ({
        nodeId: n.nodeId, nodeType: n.nodeType, status: n.status, statusCode: n.statusCode, attempts: n.attempts, durationMs: Math.round(n.durationMs),
        ...(n.error ? { error: n.error } : {}),
      })),
    },
    ...(run.error ? { error: run.error } : {}),
  };
}
