import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { sha256 } from '../canonical.ts';
import { EngineError, toEngineError, type ErrorCode } from '../errors.ts';
import type { CompiledNode, ExecutionPlan, ScopePlan } from '../flow/compile.ts';
import type { RetryPolicy } from '../flow/schema.ts';
import { collectRefs } from '../flow/template.ts';
import type { AgentTurn, NodeContext, NodeEvent, NodeOutput, Services, Usage } from '../nodes/types.ts';
import { Semaphore } from './semaphore.ts';
import { hashValue, redact, type TraceEvent, type TraceOutputMode } from './trace.ts';

export type NodeStatus = 'success' | 'failed' | 'skipped' | 'cancelled';

export interface NodeRecord {
  nodeId: string;
  nodeType: string;
  status: NodeStatus;
  statusCode: number;
  attempts: number;
  durationMs: number;
  output?: unknown;
  branches?: string[];
  error?: { code: ErrorCode; message: string; retryable: boolean };
  reused?: boolean;
  usage?: Partial<Usage>;
}

export interface RunResult {
  runId: string;
  flowId: string;
  version: string;
  status: 'success' | 'failed';
  statusCode: number;
  input: unknown;
  output: unknown;
  error?: { code: ErrorCode; message: string; nodeId?: string; retryable: boolean };
  /** Top-level node records. Per-iteration loop records live in the trace. */
  nodes: Record<string, NodeRecord>;
  usage: Usage;
  /** Local models that served this run, as `connection/model`. */
  models: string[];
  timeTakenMs: number;
  trace: TraceEvent[];
}

export interface ExecuteOptions {
  payload: unknown;
  services: Services;
  runId?: string;
  /** Max node handlers running at once across the whole run. 1 = strictly sequential. */
  concurrency?: number;
  /** Whole-run budget. The original vendor documents ~2 min for sync runs and ~20 min for async runs. */
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Fail on `{{refs}}` that resolve to undefined instead of substituting an empty value. */
  strictTemplates?: boolean;
  maxLoopIterations?: number;
  /** Retry-from-failed: successful node outputs from this earlier run are reused, not re-executed. */
  previous?: RunResult;
  /** Idempotency keys derive from this, so reruns of the same request present the same keys downstream. */
  idempotencyRoot?: string;
  traceOutputs?: TraceOutputMode;
  onEvent?: (event: TraceEvent) => void;
  /** Live progress from nodes (streamed tokens); not stored in the trace. */
  onNodeEvent?: (nodeId: string, event: NodeEvent) => void;
  /** Max supervisor turns for agent loops when a node does not set `maxIterations`. */
  maxAgentIterations?: number;
}

interface RunCtx {
  plan: ExecutionPlan;
  opts: ExecuteOptions;
  runId: string;
  idempotencyRoot: string;
  signal: AbortSignal;
  deadlineAt: number;
  permits: Semaphore;
  strict: boolean;
  maxLoopIterations: number;
  reuse: Map<string, NodeRecord>;
  loopResults: Map<string, unknown>;
  usage: Usage;
  models: Set<string>;
  emit: (e: Omit<TraceEvent, 'ts' | 'runId' | 'flowId' | 'version'>) => void;
}

interface ScopeResult {
  records: Map<string, NodeRecord>;
  failure?: EngineError;
}

type MutableScope = Map<string, unknown>;

const NO_RETRY: RetryPolicy = { maxAttempts: 1, delayMs: 0, backoff: 'fixed', jitter: false };

export async function executePlan(plan: ExecutionPlan, opts: ExecuteOptions): Promise<RunResult> {
  const runId = opts.runId ?? randomUUID();
  const t0 = performance.now();
  const deadlineMs = opts.deadlineMs ?? 120_000;
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new EngineError('DEADLINE_EXCEEDED', `Run exceeded its ${deadlineMs} ms budget`)),
    deadlineMs,
  );
  const onCancel = () => controller.abort(new EngineError('CANCELLED', 'Run was cancelled'));
  if (opts.signal?.aborted) onCancel();
  opts.signal?.addEventListener('abort', onCancel, { once: true });

  const trace: TraceEvent[] = [];
  const run: RunCtx = {
    plan,
    opts,
    runId,
    idempotencyRoot: opts.idempotencyRoot ?? runId,
    signal: controller.signal,
    deadlineAt: Date.now() + deadlineMs,
    permits: new Semaphore(opts.concurrency ?? 8),
    strict: opts.strictTemplates ?? true,
    maxLoopIterations: opts.maxLoopIterations ?? 1000,
    reuse: new Map(Object.values(opts.previous?.nodes ?? {}).filter((r) => r.status === 'success').map((r) => [r.nodeId, r])),
    loopResults: new Map(),
    usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0 },
    models: new Set(),
    emit: (e) => {
      const event: TraceEvent = { ts: Date.now(), runId, flowId: plan.flowId, version: plan.version, ...e };
      trace.push(event);
      opts.onEvent?.(event);
    },
  };

  run.emit({ type: 'run.start' });
  const rootScope: MutableScope = new Map();
  rootScope.set('secrets', { project: safeCall(opts.services.secrets) });
  rootScope.set('env', safeCall(opts.services.env));
  let result: ScopeResult;
  try {
    result = await runScope(run, plan.root, rootScope, [], undefined, run.signal);
  } finally {
    clearTimeout(deadline);
    opts.signal?.removeEventListener('abort', onCancel);
  }

  let failure = result.failure;
  let output: unknown;
  if (!failure) {
    const ran = plan.responseIds.map((id) => result.records.get(id)).filter((r) => r?.status === 'success');
    if (ran.length === 0) failure = new EngineError('NO_RESPONSE', 'No response node ran (every response node was on a branch that was not taken)');
    else output = ran[0]!.output;
  }
  const status = failure ? 'failed' : 'success';
  const statusCode = !failure ? 200 : failure.code === 'BAD_PAYLOAD' ? 400 : 500;
  const error = failure ? { ...failure.toJSON() } : undefined;
  run.emit({ type: 'run.end', statusCode, durationMs: performance.now() - t0, ...(error ? { error } : {}) });

  return {
    runId,
    flowId: plan.flowId,
    version: plan.version,
    status,
    statusCode,
    input: opts.payload,
    output,
    ...(error ? { error } : {}),
    nodes: Object.fromEntries(result.records),
    usage: run.usage,
    models: [...run.models],
    timeTakenMs: performance.now() - t0,
    trace,
  };
}

async function runScope(
  run: RunCtx,
  scopePlan: ScopePlan,
  scope: MutableScope,
  iteration: number[],
  rootOutput: unknown,
  parentSignal: AbortSignal,
  rootBranches?: string[],
): Promise<ScopeResult> {
  const scopeController = new AbortController();
  const signal = AbortSignal.any([parentSignal, scopeController.signal]);
  const records = new Map<string, NodeRecord>();
  const all = [scopePlan.rootId, ...scopePlan.members];
  const remaining = new Map(all.map((id) => [id, scopePlan.preds.get(id)?.length ?? 0]));
  const active = new Map(all.map((id) => [id, 0]));
  const ready: string[] = [];
  let running = 0;
  let failure: EngineError | undefined;
  let settle!: () => void;
  const done = new Promise<void>((resolve) => (settle = resolve));

  const propagate = (id: string, rec: NodeRecord) => {
    for (const succ of scopePlan.succs.get(id) ?? []) {
      for (const edge of scopePlan.preds.get(succ)!) {
        if (edge.source !== id) continue;
        remaining.set(succ, remaining.get(succ)! - 1);
        const isActive = rec.status === 'success' && (edge.branch === undefined || (rec.branches ?? []).includes(edge.branch));
        if (isActive) active.set(succ, active.get(succ)! + 1);
      }
      if (remaining.get(succ) === 0 && !records.has(succ)) {
        if (active.get(succ)! > 0) ready.push(succ);
        else skip(succ);
      }
    }
  };

  const skip = (id: string) => {
    const c = run.plan.nodes.get(id)!;
    const rec: NodeRecord = { nodeId: id, nodeType: c.node.type, status: 'skipped', statusCode: 304, attempts: 0, durationMs: 0 };
    records.set(id, rec);
    run.emit({ type: 'node.skipped', nodeId: id, nodeType: c.node.type, statusCode: 304, ...iter(iteration) });
    propagate(id, rec);
  };

  const finish = (id: string, rec: NodeRecord) => {
    running--;
    records.set(id, rec);
    if (rec.status === 'success') {
      scope.set(id, { output: rec.output });
      propagate(id, rec);
    } else if (!failure) {
      failure = rec.status === 'cancelled' && signal.aborted ? toEngineError(signal.reason) : new EngineError(rec.error?.code ?? 'INTERNAL', rec.error?.message ?? 'Node failed', {
        nodeId: id,
        retryable: rec.error?.retryable ?? false,
      });
      // Fail fast: stop scheduling and cancel in-flight siblings so no work outlives the run.
      scopeController.abort(new EngineError('CANCELLED', `Cancelled because ${id} failed`));
    }
    pump();
  };

  const pump = () => {
    while (!failure && ready.length > 0) {
      const id = ready.shift()!;
      running++;
      runOne(run, scopePlan, id, scope, iteration, signal).then(
        (rec) => finish(id, rec),
        (err) => finish(id, failedRecord(run.plan.nodes.get(id)!, toEngineError(err, id), 1, 0)),
      );
    }
    if (running === 0 && (failure || ready.length === 0)) settle();
  };

  if (rootOutput !== undefined) {
    const c = run.plan.nodes.get(scopePlan.rootId)!;
    const rec: NodeRecord = {
      nodeId: scopePlan.rootId, nodeType: c.node.type, status: 'success', statusCode: 200, attempts: 0, durationMs: 0, output: rootOutput,
      ...(rootBranches ? { branches: rootBranches } : {}),
    };
    records.set(scopePlan.rootId, rec);
    scope.set(scopePlan.rootId, { output: rootOutput });
    propagate(scopePlan.rootId, rec);
  } else {
    ready.push(scopePlan.rootId);
  }
  pump();
  await done;

  if (failure) {
    for (const id of all) {
      if (records.has(id)) continue;
      const c = run.plan.nodes.get(id)!;
      records.set(id, { nodeId: id, nodeType: c.node.type, status: 'cancelled', statusCode: 0, attempts: 0, durationMs: 0 });
    }
  }
  return failure ? { records, failure } : { records };
}

const iter = (iteration: number[]) => (iteration.length ? { iteration } : {});

function failedRecord(c: CompiledNode, err: EngineError, attempts: number, durationMs: number): NodeRecord {
  return {
    nodeId: c.node.id,
    nodeType: c.node.type,
    status: err.code === 'CANCELLED' ? 'cancelled' : 'failed',
    statusCode: err.code === 'BAD_PAYLOAD' ? 400 : 500,
    attempts,
    durationMs,
    error: { code: err.code, message: err.message, retryable: err.retryable },
  };
}

function contextFor(run: RunCtx, c: CompiledNode, scope: MutableScope, iteration: number[], signal: AbortSignal, attempt: number, values: Record<string, unknown>): NodeContext {
  return {
    runId: run.runId,
    flowId: run.plan.flowId,
    nodeId: c.node.id,
    node: c.node,
    attempt,
    signal,
    idempotencyKey: sha256(`${run.idempotencyRoot}:${c.node.id}:${iteration.join('.')}`).slice(0, 32),
    values,
    scope,
    payload: run.opts.payload,
    services: run.opts.services,
    strictTemplates: run.strict,
    emit: (event) => run.opts.onNodeEvent?.(c.node.id, event),
  };
}

function safeCall(fn: (() => Record<string, string>) | undefined): Record<string, string> {
  try {
    return fn?.() ?? {};
  } catch {
    return {};
  }
}

async function runOne(run: RunCtx, scopePlan: ScopePlan, id: string, scope: MutableScope, iteration: number[], signal: AbortSignal): Promise<NodeRecord> {
  const c = run.plan.nodes.get(id)!;
  const previous = iteration.length === 0 ? run.reuse.get(id) : undefined;

  if (c.kind === 'loopEnd' || c.kind === 'agentEnd') {
    const key = `${id}:${iteration.join('.')}`;
    const output = previous ? previous.output : run.loopResults.get(key);
    run.emit({ type: 'node.success', nodeId: id, nodeType: c.node.type, statusCode: previous ? 208 : 200, outputHash: hashValue(output), ...iter(iteration) });
    return { nodeId: id, nodeType: c.node.type, status: 'success', statusCode: previous ? 208 : 200, attempts: 0, durationMs: 0, output, ...(previous ? { reused: true } : {}) };
  }
  if (previous) {
    if (c.kind === 'loopStart' || c.kind === 'agentStart') {
      const loop = scopePlan.loops.get(id)!;
      if (!run.reuse.has(loop.endId)) return c.kind === 'agentStart' ? runAgentLoop(run, scopePlan, c, scope, iteration, signal) : runLoop(run, scopePlan, c, scope, iteration, signal);
    }
    run.emit({ type: 'node.reused', nodeId: id, nodeType: c.node.type, statusCode: 208, outputHash: hashValue(previous.output) });
    return { ...previous, statusCode: 208, attempts: 0, durationMs: 0, reused: true };
  }
  if (c.kind === 'loopStart') return runLoop(run, scopePlan, c, scope, iteration, signal);
  if (c.kind === 'agentStart') return runAgentLoop(run, scopePlan, c, scope, iteration, signal);
  return runWithPolicy(run, c, scope, iteration, signal);
}

function backoffMs(policy: RetryPolicy, attempt: number): number {
  const base = Math.min(policy.backoff === 'exponential' ? policy.delayMs * 2 ** (attempt - 1) : policy.delayMs, 30_000);
  return policy.jitter ? Math.round(Math.random() * base) : base;
}

async function runWithPolicy(run: RunCtx, c: CompiledNode, scope: MutableScope, iteration: number[], signal: AbortSignal): Promise<NodeRecord> {
  const node = c.node;
  const policy = node.logic?.retry ?? NO_RETRY;
  const t0 = performance.now();
  const inputHash = hashValue({
    values: node.values,
    upstream: Object.fromEntries([...new Set(collectRefs(node.values).map((r) => r.nodeId))].filter((n) => n !== 'secrets').map((n) => [n, (scope.get(n) as { output?: unknown } | undefined)?.output])),
  });
  run.emit({ type: 'node.start', nodeId: node.id, nodeType: node.type, inputHash, ...iter(iteration) });

  for (let attempt = 1; ; attempt++) {
    try {
      const { out, statusCode } = await attemptWithFallback(run, c, scope, iteration, signal, attempt);
      addUsage(run, out.usage);
      for (const m of out.models ?? []) run.models.add(m);
      const durationMs = performance.now() - t0;
      const code = statusCode === 200 && attempt > 1 ? 204 : statusCode;
      run.emit({
        type: 'node.success', nodeId: node.id, nodeType: node.type, attempt, statusCode: code, durationMs,
        outputHash: hashValue(out.output),
        ...(run.opts.traceOutputs === 'preview' ? { output: redact(out.output) } : {}),
        ...iter(iteration),
      });
      return {
        nodeId: node.id, nodeType: node.type, status: 'success', statusCode: code, attempts: attempt, durationMs,
        output: out.output, ...(out.branches ? { branches: out.branches } : {}), ...(out.usage ? { usage: out.usage } : {}),
      };
    } catch (e) {
      const err = signal.aborted ? toEngineError(signal.reason, node.id) : toEngineError(e, node.id);
      addUsage(run, (err.details as { usage?: Partial<Usage> } | undefined)?.usage);
      const durationMs = performance.now() - t0;
      const errorInfo = { code: err.code, message: err.message, retryable: err.retryable };
      if (signal.aborted) {
        const failedHere = err.code === 'DEADLINE_EXCEEDED';
        run.emit({ type: failedHere ? 'node.failed' : 'node.cancelled', nodeId: node.id, nodeType: node.type, attempt, durationMs, error: errorInfo, ...iter(iteration) });
        return failedRecord(c, err, attempt, durationMs);
      }
      const unsafe = err.retryable && c.sideEffect && !c.idempotent;
      const delayMs = backoffMs(policy, attempt);
      const pastDeadline = Date.now() + delayMs >= run.deadlineAt;
      if (attempt >= policy.maxAttempts || !err.retryable || unsafe || pastDeadline) {
        const suppressed = attempt < policy.maxAttempts && err.retryable ? (unsafe ? 'side-effect-not-idempotent' : 'deadline') : undefined;
        run.emit({
          type: 'node.failed', nodeId: node.id, nodeType: node.type, attempt, statusCode: err.code === 'BAD_PAYLOAD' ? 400 : 500, durationMs,
          error: errorInfo, ...(suppressed ? { retrySuppressed: suppressed } : {}), ...iter(iteration),
        });
        return failedRecord(c, err, attempt, durationMs);
      }
      run.emit({ type: 'node.retry', nodeId: node.id, nodeType: node.type, attempt, statusCode: 509, delayMs, error: errorInfo, ...iter(iteration) });
      try {
        if (delayMs > 0) await sleep(delayMs, undefined, { signal });
      } catch {
        const reason = toEngineError(signal.reason, node.id);
        run.emit({ type: 'node.cancelled', nodeId: node.id, nodeType: node.type, attempt, error: { code: reason.code, message: reason.message, retryable: false }, ...iter(iteration) });
        return failedRecord(c, reason, attempt, performance.now() - t0);
      }
    }
  }
}

/** One attempt = primary config, then (if configured) the fallback config when the primary fails. */
async function attemptWithFallback(run: RunCtx, c: CompiledNode, scope: MutableScope, iteration: number[], signal: AbortSignal, attempt: number): Promise<{ out: NodeOutput; statusCode: number }> {
  const logic = c.node.logic;
  const fallback = logic?.fallback;
  const primaryTimeout = fallback ? Math.min(fallback.timeoutMs, logic?.timeoutMs ?? Infinity) : logic?.timeoutMs;
  try {
    return { out: await invoke(run, c, scope, iteration, signal, attempt, c.node.values, primaryTimeout), statusCode: 200 };
  } catch (e) {
    if (!fallback || signal.aborted) throw e;
    const primary = toEngineError(e, c.node.id);
    const out = await invoke(run, c, scope, iteration, signal, attempt, { ...c.node.values, ...fallback.values }, logic?.timeoutMs);
    return { out, statusCode: primary.code === 'TIMEOUT' ? 408 : 200 };
  }
}

async function invoke(run: RunCtx, c: CompiledNode, scope: MutableScope, iteration: number[], signal: AbortSignal, attempt: number, values: Record<string, unknown>, timeoutMs: number | undefined): Promise<NodeOutput> {
  const attemptSignal = timeoutMs && Number.isFinite(timeoutMs) ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal;
  await run.permits.acquire(signal);
  try {
    const ctx = contextFor(run, c, scope, iteration, attemptSignal, attempt, values);
    return await raceAbort(c.handler.run(ctx), attemptSignal);
  } finally {
    run.permits.release();
  }
}

/** Never let a handler that ignores its AbortSignal hold the run open past a timeout or cancellation. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function addUsage(run: RunCtx, usage: Partial<Usage> | undefined) {
  if (!usage) return;
  run.usage.llmCalls += usage.llmCalls ?? 0;
  run.usage.inputTokens += usage.inputTokens ?? 0;
  run.usage.outputTokens += usage.outputTokens ?? 0;
}

async function runLoop(run: RunCtx, scopePlan: ScopePlan, c: CompiledNode, scope: MutableScope, iteration: number[], signal: AbortSignal): Promise<NodeRecord> {
  const id = c.node.id;
  const loop = scopePlan.loops.get(id)!;
  const t0 = performance.now();
  run.emit({ type: 'node.start', nodeId: id, nodeType: c.node.type, ...iter(iteration) });
  const fail = (err: EngineError) => {
    const durationMs = performance.now() - t0;
    run.emit({ type: signal.aborted && err.code === 'CANCELLED' ? 'node.cancelled' : 'node.failed', nodeId: id, nodeType: c.node.type, durationMs, error: { code: err.code, message: err.message, retryable: err.retryable }, ...iter(iteration) });
    return failedRecord(c, err, 1, durationMs);
  };

  let items: unknown[];
  let waitMs: number;
  let concurrency: number;
  try {
    ({ items, waitMs, concurrency = 1 } = await c.handler.iterate!(contextFor(run, c, scope, iteration, signal, 1, c.node.values)));
  } catch (e) {
    return fail(toEngineError(e, id));
  }
  if (items.length > run.maxLoopIterations) {
    return fail(new EngineError('LOOP_LIMIT', `Loop ${id} would run ${items.length} iterations; the limit is ${run.maxLoopIterations}`, { nodeId: id }));
  }

  const loopOutput: unknown[] = new Array(items.length);
  let firstFailure: EngineError | undefined;
  const runIteration = async (i: number) => {
    const path = [...iteration, i];
    run.emit({ type: 'loop.iteration', nodeId: id, nodeType: c.node.type, iteration: path });
    const res = await runScope(run, loop.body, new Map(scope), path, { currentValue: items[i], index: i }, signal);
    if (res.failure) {
      const inner = res.failure;
      firstFailure ??= new EngineError(inner.code, `Loop ${id} iteration ${i}: ${inner.message}`, { nodeId: inner.nodeId ?? id, retryable: inner.retryable, cause: inner });
      return;
    }
    loopOutput[i] = iterationOutput(loop.sinks, loop.body.members, res.records);
  };

  if (concurrency <= 1) {
    for (let i = 0; i < items.length; i++) {
      if (signal.aborted) return fail(toEngineError(signal.reason, id));
      if (i > 0 && waitMs > 0) {
        try {
          await sleep(waitMs, undefined, { signal });
        } catch {
          return fail(toEngineError(signal.reason, id));
        }
      }
      await runIteration(i);
      if (firstFailure) return fail(firstFailure);
    }
  } else {
    // Batch: up to `concurrency` iterations at once; the first failure stops new iterations.
    let next = 0;
    const worker = async () => {
      while (next < items.length && !firstFailure && !signal.aborted) await runIteration(next++);
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    if (signal.aborted) return fail(toEngineError(signal.reason, id));
    if (firstFailure) return fail(firstFailure);
  }
  run.loopResults.set(`${loop.endId}:${iteration.join('.')}`, { loopOutput, batchOutput: loopOutput, iterations: items.length });
  const durationMs = performance.now() - t0;
  const output = { iterations: items.length };
  run.emit({ type: 'node.success', nodeId: id, nodeType: c.node.type, statusCode: 200, durationMs, outputHash: hashValue(output), ...iter(iteration) });
  return { nodeId: id, nodeType: c.node.type, status: 'success', statusCode: 200, attempts: 1, durationMs, output };
}

/** What a sub-agent "said": an AI node's text, otherwise its output without token metadata. */
function agentResult(output: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const o = output as Record<string, unknown>;
  for (const key of ['generatedResponse', 'modelResponse']) if (typeof o[key] === 'string') return o[key];
  const { _meta: _ignored, ...rest } = o;
  return rest;
}

/** One iteration's result, keyed by node id: the nodes feeding the loop end first, then the rest of the body. */
function iterationOutput(sinks: string[], members: string[], records: Map<string, NodeRecord>): Record<string, { output: unknown }> {
  const out: Record<string, { output: unknown }> = {};
  for (const id of [...sinks, ...members]) {
    const rec = records.get(id);
    if (rec?.status === 'success' && !(id in out)) out[id] = { output: rec.output };
  }
  return out;
}

/**
 * Supervisor agent loop: the agent node picks a sub-agent (one of its branches) and its input, the
 * chosen branch runs, its result is fed back, and this repeats until the supervisor finishes or hits
 * `maxIterations`. Only the chosen branch runs in each turn; the others are skipped (304).
 */
async function runAgentLoop(run: RunCtx, scopePlan: ScopePlan, c: CompiledNode, scope: MutableScope, iteration: number[], signal: AbortSignal): Promise<NodeRecord> {
  const id = c.node.id;
  const loop = scopePlan.loops.get(id)!;
  const t0 = performance.now();
  run.emit({ type: 'node.start', nodeId: id, nodeType: c.node.type, ...iter(iteration) });
  const fail = (err: EngineError) => {
    const durationMs = performance.now() - t0;
    run.emit({ type: signal.aborted && err.code === 'CANCELLED' ? 'node.cancelled' : 'node.failed', nodeId: id, nodeType: c.node.type, durationMs, error: { code: err.code, message: err.message, retryable: err.retryable }, ...iter(iteration) });
    return failedRecord(c, err, 1, durationMs);
  };
  const configured = Number(c.node.values['maxIterations']);
  const maxTurns = Math.min(Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : (run.opts.maxAgentIterations ?? 5), run.maxLoopIterations);
  const history: AgentTurn[] = [];
  let finalResponse: unknown;
  let lastInput: Record<string, unknown> = {};
  let finished = false;
  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal.aborted) return fail(toEngineError(signal.reason, id));
    let decision;
    try {
      decision = await raceAbort(c.handler.decide!(contextFor(run, c, scope, [...iteration, turn], signal, 1, c.node.values), history), signal);
    } catch (e) {
      return fail(toEngineError(e, id));
    }
    addUsage(run, decision.usage);
    if (decision.done) {
      finalResponse = decision.finalResponse;
      finished = true;
      break;
    }
    lastInput = decision.input;
    const path = [...iteration, turn];
    run.emit({ type: 'loop.iteration', nodeId: id, nodeType: c.node.type, iteration: path });
    const res = await runScope(run, loop.body, new Map(scope), path, { ...decision.input, agent: decision.agent }, signal, [decision.agent]);
    if (res.failure) {
      const inner = res.failure;
      return fail(new EngineError(inner.code, `Agent ${id} turn ${turn} (${decision.agent}): ${inner.message}`, { nodeId: inner.nodeId ?? id, retryable: inner.retryable, cause: inner }));
    }
    const result = iterationOutput(loop.sinks, loop.body.members, res.records);
    const sinkOutputs = loop.sinks.map((s) => res.records.get(s)).filter((r) => r?.status === 'success').map((r) => agentResult(r!.output));
    history.push({ agent: decision.agent, input: decision.input, output: sinkOutputs.length === 1 ? sinkOutputs[0] : sinkOutputs.length ? sinkOutputs : result });
    finalResponse = history.at(-1)!.output;
  }
  if (!finished) run.emit({ type: 'node.warning', nodeId: id, nodeType: c.node.type, message: `Supervisor reached its limit of ${maxTurns} turns; returning the last sub-agent result`, ...iter(iteration) });
  run.loopResults.set(`${loop.endId}:${iteration.join('.')}`, { finalResponse, history, turns: history.length, finished });
  const durationMs = performance.now() - t0;
  const output = { ...lastInput, turns: history.length };
  run.emit({ type: 'node.success', nodeId: id, nodeType: c.node.type, statusCode: 200, durationMs, outputHash: hashValue(output), ...iter(iteration) });
  return { nodeId: id, nodeType: c.node.type, status: 'success', statusCode: 200, attempts: 1, durationMs, output };
}
