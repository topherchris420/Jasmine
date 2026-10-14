import { json, parseJson, type JasmineDb } from '../db/database.ts';
import type { RunResult } from '../runtime/executor.ts';
import type { TraceEvent } from '../runtime/trace.ts';

export type RunSource = 'api' | 'studio' | 'webhook' | 'chat' | 'search' | 'ask' | 'cron' | 'folder' | 'flow' | 'retry';

export interface RunSummary {
  id: string;
  flowId: string;
  version: string;
  source: RunSource;
  mode: 'realtime' | 'async';
  status: 'in-progress' | 'success' | 'failed' | 'error' | 'cancelled';
  statusCode: number | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  models: string[];
  retryOf: string | null;
}

export interface RunDetail extends RunSummary {
  input: unknown;
  output: unknown;
  error: unknown;
  nodes: unknown;
  trace: TraceEvent[];
}

interface Row {
  id: string; flow_id: string; version: string; source: string; mode: string; status: string; status_code: number | null;
  started_at: string; ended_at: string | null; duration_ms: number | null; input: string | null; output: string | null;
  error_code: string | null; error: string | null; nodes: string | null; trace: string | null;
  llm_calls: number; input_tokens: number; output_tokens: number; models: string | null; retry_of: string | null;
}

export interface RunQuery {
  flowId?: string;
  status?: string;
  source?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  before?: string;
}

const SECRET_KEY = /(api[-_]?key|token(?!s)|secret|password|passwd|authorization|credential|cookie|private[-_]?key)/i;

/** Log-sized copy of a value: secrets masked, long text and lists clipped. */
export function logValue(value: unknown, depth = 0, secrets: string[] = []): unknown {
  if (depth > 8) return '[…]';
  if (typeof value === 'string') {
    let clean = value.replace(/\b(sk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, '[REDACTED]');
    for (const s of secrets) if (s.length >= 6) clean = clean.split(s).join('[SECRET]');
    return clean.length > 8000 ? `${clean.slice(0, 8000)}…(+${clean.length - 8000} chars)` : clean;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((v) => (Array.isArray(v) && v.length > 16 && v.every((x) => typeof x === 'number') ? `[vector ${v.length}]` : logValue(v, depth + 1, secrets)));
    return value.length > 100 ? [...items, `…(+${value.length - 100} items)`] : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[REDACTED]' : logValue(v, depth + 1, secrets)]));
  }
  return value;
}

export class RunStore {
  private readonly db: JasmineDb;
  secrets: () => string[] = () => [];
  onFinished: (result: RunResult, status: RunSummary['status']) => void = () => {};

  constructor(db: JasmineDb) {
    this.db = db;
  }

  start(r: { id: string; flowId: string; version: string; source: RunSource; mode: 'realtime' | 'async'; input: unknown; retryOf?: string | undefined }): void {
    this.db.run(
      'INSERT OR REPLACE INTO runs (id, flow_id, version, source, mode, status, started_at, input, retry_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      r.id, r.flowId, r.version, r.source, r.mode, 'in-progress', new Date().toISOString(), json(logValue(r.input, 0, this.secrets())), r.retryOf ?? null,
    );
  }

  finish(result: RunResult, status: RunSummary['status']): void {
    const secrets = this.secrets();
    const nodes = Object.values(result.nodes).map((n) => ({ ...n, ...(n.output !== undefined ? { output: logValue(n.output, 0, secrets) } : {}) }));
    const trace = result.trace.length > 5000 ? [...result.trace.slice(0, 2500), ...result.trace.slice(-2500)] : result.trace;
    this.db.run(
      `UPDATE runs SET status = ?, status_code = ?, ended_at = ?, duration_ms = ?, output = ?, error_code = ?, error = ?, nodes = ?, trace = ?,
         llm_calls = ?, input_tokens = ?, output_tokens = ?, models = ?, version = ? WHERE id = ?`,
      status, result.statusCode, new Date().toISOString(), Math.round(result.timeTakenMs * 10) / 10, json(logValue(result.output, 0, secrets)),
      result.error?.code ?? null, result.error ? json(result.error) : null, json(nodes), json(logValue(trace, 0, secrets)),
      result.usage.llmCalls, result.usage.inputTokens, result.usage.outputTokens, json(result.models ?? []), result.version, result.runId,
    );
    this.onFinished(result, status);
  }

  /** Runs left in progress by a previous process cannot finish; mark them failed. */
  markInterrupted(): number {
    return Number(this.db.run(
      `UPDATE runs SET status = 'failed', error_code = 'INTERRUPTED', error = ?, ended_at = ? WHERE status = 'in-progress'`,
      json({ code: 'INTERRUPTED', message: 'Jasmine stopped while this run was in progress', retryable: true }), new Date().toISOString(),
    ).changes);
  }

  get(id: string): RunDetail | undefined {
    const row = this.db.get<Row>('SELECT * FROM runs WHERE id = ?', id);
    return row ? this.detail(row) : undefined;
  }

  list(q: RunQuery = {}): { runs: RunSummary[]; nextBefore: string | null } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.flowId) { where.push('flow_id = ?'); params.push(q.flowId); }
    if (q.status) { where.push('status = ?'); params.push(q.status); }
    if (q.source) { where.push('source = ?'); params.push(q.source); }
    if (q.from) { where.push('started_at >= ?'); params.push(q.from); }
    if (q.to) { where.push('started_at <= ?'); params.push(q.to); }
    if (q.before) {
      const split = q.before.indexOf('|');
      if (split >= 0) { const at = q.before.slice(0, split), id = q.before.slice(split + 1); where.push('(started_at < ? OR (started_at = ? AND id < ?))'); params.push(at, at, id); }
      else { where.push('started_at < ?'); params.push(q.before); }
    }
    if (q.search) { where.push('(id LIKE ? OR input LIKE ? OR output LIKE ? OR error LIKE ?)'); const like = `%${q.search}%`; params.push(like, like, like, like); }
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? 50), 1), 500);
    const rows = this.db.all<Row>(
      `SELECT id, flow_id, version, source, mode, status, status_code, started_at, ended_at, duration_ms, error_code, error, llm_calls, input_tokens, output_tokens, models, retry_of
       FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT ?`,
      ...params, limit + 1,
    );
    const page = rows.slice(0, limit).map((r) => this.summary(r));
    return { runs: page, nextBefore: rows.length > limit ? `${page[page.length - 1]!.startedAt}|${page[page.length - 1]!.id}` : null };
  }

  /** Aggregates for Reports: totals, a time series, per-flow, per-model, per-node and error breakdowns. */
  report(o: { from: string; to?: string; flowId?: string; bucket?: 'hour' | 'day' }) {
    const to = o.to ?? new Date().toISOString();
    const filter = `started_at >= ? AND started_at <= ?${o.flowId ? ' AND flow_id = ?' : ''}`;
    const params = o.flowId ? [o.from, to, o.flowId] : [o.from, to];
    const totals = this.db.get<{ runs: number; success: number; failed: number; avg: number | null; tin: number | null; tout: number | null; calls: number | null }>(
      `SELECT count(*) AS runs, sum(status = 'success') AS success, sum(status IN ('failed', 'error', 'cancelled')) AS failed, avg(duration_ms) AS avg,
              sum(input_tokens) AS tin, sum(output_tokens) AS tout, sum(llm_calls) AS calls FROM runs WHERE ${filter}`, ...params,
    )!;
    const durations = this.db.all<{ d: number }>(`SELECT duration_ms AS d FROM runs WHERE ${filter} AND duration_ms IS NOT NULL ORDER BY duration_ms`, ...params).map((r) => r.d);
    const pct = (p: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))]! : null);
    const fmt = o.bucket === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%dT00:00:00Z';
    const series = this.db.all<{ t: string; runs: number; failed: number; avg: number | null; tokens: number | null }>(
      `SELECT strftime('${fmt}', started_at) AS t, count(*) AS runs, sum(status IN ('failed', 'error', 'cancelled')) AS failed, avg(duration_ms) AS avg,
              sum(input_tokens + output_tokens) AS tokens FROM runs WHERE ${filter} GROUP BY t ORDER BY t`, ...params,
    );
    const byFlow = this.db.all<{ flowId: string; runs: number; failed: number; avg: number | null; tokens: number | null }>(
      `SELECT flow_id AS flowId, count(*) AS runs, sum(status IN ('failed', 'error', 'cancelled')) AS failed, avg(duration_ms) AS avg, sum(input_tokens + output_tokens) AS tokens
       FROM runs WHERE ${filter} GROUP BY flow_id ORDER BY runs DESC LIMIT 50`, ...params,
    );
    const bySource = this.db.all<{ source: string; runs: number }>(`SELECT source, count(*) AS runs FROM runs WHERE ${filter} GROUP BY source ORDER BY runs DESC`, ...params);
    const errors = this.db.all<{ code: string; runs: number; lastAt: string; message: string | null }>(
      `SELECT error_code AS code, count(*) AS runs, max(started_at) AS lastAt, max(error) AS message FROM runs WHERE ${filter} AND error_code IS NOT NULL GROUP BY error_code ORDER BY runs DESC LIMIT 20`, ...params,
    ).map((e) => ({ ...e, message: (parseJson<{ message?: string }>(e.message, {}).message ?? null) }));
    const models = new Map<string, { runs: number; tokens: number }>();
    const nodes = new Map<string, { nodeType: string; runs: number; failed: number; totalMs: number }>();
    for (const r of this.db.all<{ models: string | null; tokens: number; nodes: string | null; flow_id: string }>(
      `SELECT models, input_tokens + output_tokens AS tokens, nodes, flow_id FROM runs WHERE ${filter} ORDER BY started_at DESC LIMIT 2000`, ...params,
    )) {
      const used = parseJson<string[]>(r.models, []);
      for (const m of used) {
        const e = models.get(m) ?? { runs: 0, tokens: 0 };
        e.runs++;
        e.tokens += used.length ? r.tokens / used.length : 0;
        models.set(m, e);
      }
      for (const n of parseJson<{ nodeId: string; nodeType: string; status: string; durationMs: number }[]>(r.nodes, [])) {
        if (n.status === 'skipped') continue;
        const key = `${r.flow_id}/${n.nodeId}`;
        const e = nodes.get(key) ?? { nodeType: n.nodeType, runs: 0, failed: 0, totalMs: 0 };
        e.runs++;
        if (n.status === 'failed') e.failed++;
        e.totalMs += n.durationMs ?? 0;
        nodes.set(key, e);
      }
    }
    return {
      range: { from: o.from, to },
      totals: {
        runs: totals.runs, success: totals.success ?? 0, failed: totals.failed ?? 0,
        successRate: totals.runs ? (totals.success ?? 0) / totals.runs : null,
        avgMs: totals.avg, p50Ms: pct(0.5), p95Ms: pct(0.95), p99Ms: pct(0.99),
        llmCalls: totals.calls ?? 0, inputTokens: totals.tin ?? 0, outputTokens: totals.tout ?? 0,
      },
      series,
      byFlow,
      bySource,
      errors,
      byModel: [...models.entries()].map(([model, v]) => ({ model, runs: v.runs, tokens: Math.round(v.tokens) })).sort((a, b) => b.runs - a.runs),
      slowestNodes: [...nodes.entries()].map(([key, v]) => ({ node: key, nodeType: v.nodeType, runs: v.runs, failed: v.failed, avgMs: v.totalMs / v.runs }))
        .sort((a, b) => b.avgMs - a.avgMs).slice(0, 15),
    };
  }

  prune(maxRuns: number, maxAgeDays: number): number {
    let removed = 0;
    if (maxAgeDays > 0) {
      removed += Number(this.db.run("DELETE FROM runs WHERE started_at < ? AND status != 'in-progress'", new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()).changes);
    }
    if (maxRuns > 0) {
      removed += Number(this.db.run(
        "DELETE FROM runs WHERE status != 'in-progress' AND id IN (SELECT id FROM runs ORDER BY started_at DESC LIMIT -1 OFFSET ?)", maxRuns,
      ).changes);
    }
    return removed;
  }

  deleteFlow(flowId: string): number {
    return Number(this.db.run('DELETE FROM runs WHERE flow_id = ?', flowId).changes);
  }

  private summary(r: Row): RunSummary {
    const error = parseJson<{ message?: string } | null>(r.error, null);
    return {
      id: r.id, flowId: r.flow_id, version: r.version, source: r.source as RunSource, mode: r.mode as 'realtime' | 'async', status: r.status as RunSummary['status'],
      statusCode: r.status_code, startedAt: r.started_at, endedAt: r.ended_at, durationMs: r.duration_ms, errorCode: r.error_code, errorMessage: error?.message ?? null,
      llmCalls: r.llm_calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens, models: parseJson(r.models, []), retryOf: r.retry_of,
    };
  }

  private detail(r: Row): RunDetail {
    return {
      ...this.summary(r), input: parseJson(r.input, null), output: parseJson(r.output, null), error: parseJson(r.error, null),
      nodes: parseJson(r.nodes, []), trace: parseJson(r.trace, []),
    };
  }
}
