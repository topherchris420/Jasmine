import { canonicalJson, sha256 } from '../canonical.ts';
import type { ErrorCode } from '../errors.ts';

export type TraceEventType =
  | 'run.start'
  | 'run.end'
  | 'node.start'
  | 'node.retry'
  | 'node.success'
  | 'node.failed'
  | 'node.skipped'
  | 'node.reused'
  | 'node.cancelled'
  | 'node.warning'
  | 'loop.iteration';

export interface TraceEvent {
  ts: number;
  type: TraceEventType;
  runId: string;
  flowId: string;
  version: string;
  nodeId?: string;
  nodeType?: string;
  /** Loop iteration indexes, outermost first. */
  iteration?: number[];
  attempt?: number;
  /** Compatible log codes: 200 ok, 204 ok after retry, 208 reused in a retried run, 304 skipped, 400 bad payload, 408 fallback after timeout, 500 failed, 509 attempt failed (will retry). */
  statusCode?: number;
  durationMs?: number;
  delayMs?: number;
  error?: { code: ErrorCode; message: string; retryable: boolean };
  /** Why a retryable error was not retried. */
  retrySuppressed?: 'side-effect-not-idempotent' | 'deadline';
  inputHash?: string;
  outputHash?: string;
  output?: unknown;
  /** Human-readable note (warnings). */
  message?: string;
}

export type TraceOutputMode = 'hash' | 'preview';

const SECRET_KEY = /(api[-_]?key|token(?!s)|secret|password|passwd|authorization|credential|cookie|private[-_]?key|idempotency[-_]?key)/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g;
const MAX_STRING = 500;
const MAX_ITEMS = 20;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (typeof value === 'string') {
    const clean = value.replace(SECRET_VALUE, '[REDACTED]');
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…(+${clean.length - MAX_STRING} chars)` : clean;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => redact(v, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `…(+${value.length - MAX_ITEMS} items)`] : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1)]),
    );
  }
  return value;
}

export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value ?? null)).slice(0, 16);
}

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: 'OK' | 'ERROR' | 'UNSET'; message?: string };
  attributes: Record<string, string | number | boolean>;
}

/** Converts a run trace into OpenTelemetry-shaped spans (one per run, one per node execution). */
export function toOtelSpans(events: readonly TraceEvent[]): OtelSpan[] {
  const start = events.find((e) => e.type === 'run.start');
  const end = events.findLast((e) => e.type === 'run.end');
  if (!start) return [];
  const traceId = sha256(start.runId).slice(0, 32);
  const rootId = sha256(`${start.runId}:root`).slice(0, 16);
  const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;
  const spans: OtelSpan[] = [{
    traceId,
    spanId: rootId,
    name: `flow ${start.flowId}`,
    startTimeUnixNano: nanos(start.ts),
    endTimeUnixNano: nanos(end?.ts ?? start.ts),
    status: end?.error ? { code: 'ERROR', message: end.error.message } : { code: 'OK' },
    attributes: { 'jasmine.flow_id': start.flowId, 'jasmine.flow_version': start.version, 'jasmine.run_id': start.runId },
  }];
  const open = new Map<string, TraceEvent>();
  for (const e of events) {
    if (!e.nodeId) continue;
    const key = `${e.nodeId}:${(e.iteration ?? []).join('.')}`;
    if (e.type === 'node.start') {
      open.set(key, e);
      continue;
    }
    if (!['node.success', 'node.failed', 'node.skipped', 'node.reused', 'node.cancelled'].includes(e.type)) continue;
    const begin = open.get(key) ?? e;
    open.delete(key);
    const attributes: Record<string, string | number | boolean> = {
      'jasmine.node_id': e.nodeId,
      'jasmine.node_type': e.nodeType ?? '',
      'jasmine.status_code': e.statusCode ?? 0,
      'jasmine.attempts': e.attempt ?? 0,
    };
    if (e.iteration?.length) attributes['jasmine.iteration'] = e.iteration.join('.');
    if (begin.inputHash) attributes['jasmine.input_hash'] = begin.inputHash;
    if (e.outputHash) attributes['jasmine.output_hash'] = e.outputHash;
    if (e.error) attributes['error.type'] = e.error.code;
    spans.push({
      traceId,
      spanId: sha256(`${start.runId}:${key}`).slice(0, 16),
      parentSpanId: rootId,
      name: `${e.nodeType ?? 'node'} ${e.nodeId}`,
      startTimeUnixNano: nanos(begin.ts),
      endTimeUnixNano: nanos(e.ts),
      status: e.type === 'node.failed' ? { code: 'ERROR', message: e.error?.message ?? '' } : { code: e.type === 'node.success' || e.type === 'node.reused' ? 'OK' : 'UNSET' },
      attributes,
    });
  }
  return spans;
}
