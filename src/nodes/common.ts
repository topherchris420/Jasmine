import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EngineError } from '../errors.ts';
import type { Diagnostic, FlowNode } from '../flow/schema.ts';
import { parseJsonTemplate, resolveJsonTemplate, resolveValue } from '../flow/template.ts';
import type { ModelRef } from '../llm/router.ts';
import type { FieldSpec, NodeContext } from './types.ts';

export const opts = (ctx: NodeContext) => ({ strict: ctx.strictTemplates, nodeId: ctx.nodeId });
export const lenient = (ctx: NodeContext) => ({ strict: false, nodeId: ctx.nodeId });

/** Resolves a value's templates (strict unless told otherwise). */
export const val = (ctx: NodeContext, key: string, fallback?: unknown, strict = true): unknown => {
  const raw = ctx.values[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return resolveValue(raw, ctx.scope, strict ? opts(ctx) : lenient(ctx));
};

export const str = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

export function num(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(v: unknown, fallback = false): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** Values Studio stores as JSON strings (`"[]"`, `"{...}"`) or as already-parsed data. */
export function jsonish(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t) return undefined;
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

/** Resolves a JSON-template field (`outputMapping`, `headers`, `metadata`…): parse first, then resolve. */
export function jsonField(ctx: NodeContext, key: string, fallback: unknown = undefined, strict = true): unknown {
  const raw = ctx.values[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'string' && !/^\s*[[{]/.test(raw)) return resolveValue(raw, ctx.scope, strict ? opts(ctx) : lenient(ctx));
  return resolveJsonTemplate(raw, ctx.scope, strict ? opts(ctx) : lenient(ctx));
}

export function firstString(v: unknown): string | undefined {
  if (Array.isArray(v)) return firstString(v[0]);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function jsonDiagnostic(node: FlowNode, field: string): Diagnostic[] {
  const raw = node.values[field];
  if (typeof raw !== 'string' || raw.trim() === '' || !/^\s*[[{]/.test(raw)) return [];
  try {
    parseJsonTemplate(raw);
    return [];
  } catch (e) {
    return [{ severity: 'error', code: 'INVALID_JSON_TEMPLATE', message: `${field} is not valid JSON: ${(e as Error).message}`, nodeId: node.id }];
  }
}

export function required(node: FlowNode, ...fields: string[]): Diagnostic[] {
  return fields
    .filter((f) => {
      const v = node.values[f];
      return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    })
    .map((f) => ({ severity: 'error' as const, code: 'FIELD_REQUIRED', message: `${f} is required`, nodeId: node.id }));
}

/* ---------- model references ---------- */

export interface ModelConfig extends ModelRef {
  params: Record<string, unknown>;
}

/**
 * Reads `generativeModelName` / `embeddingModelName` in any of their export shapes: an array of
 * configs (configA, configB… for fallback), a single config object, or a bare model id.
 */
export function modelConfigs(raw: unknown): ModelConfig[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
  const out: ModelConfig[] = [];
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) {
      const [conn, ...rest] = item.includes('::') ? item.split('::') : [undefined, item];
      out.push({ model: rest.join('::').trim(), ...(conn ? { connection: conn } : {}), params: {} });
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const model = o['model_name'] ?? o['model'] ?? o['modelName'];
      const provider = o['provider_name'] ?? o['provider'];
      const connection = o['connection'] ?? o['credential_name'] ?? o['credentialId'];
      const ref: ModelConfig = { params: (o['params'] && typeof o['params'] === 'object' ? o['params'] : {}) as Record<string, unknown> };
      if (typeof model === 'string' && model.trim()) ref.model = model.replace(/\(\d+\)$/, '').trim();
      if (typeof provider === 'string' && provider) ref.provider = provider;
      if (typeof connection === 'string' && connection) ref.connection = connection;
      if (ref.model || ref.provider || ref.connection) out.push(ref);
    }
  }
  return out;
}

export function modelLabel(connectionId: string, model: string): string {
  return `${connectionId}/${model}`;
}

/* ---------- files ---------- */

export interface LoadedFile {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Loads `http(s)://`, `data:` and uploaded `file:<id>` URLs. */
export async function loadFile(url: string, ctx: NodeContext): Promise<LoadedFile> {
  const trimmed = url.trim();
  const data = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(trimmed);
  if (data) {
    const bytes = data[2] ? Buffer.from(data[3]!, 'base64') : Buffer.from(decodeURIComponent(data[3]!), 'utf8');
    return { bytes, name: 'inline', mime: data[1] || 'text/plain' };
  }
  const local = /^file:([A-Za-z0-9_-]{8,64})(?:\/(.*))?$/.exec(trimmed);
  if (local) {
    if (!ctx.services.filesDir) throw new EngineError('BAD_PAYLOAD', 'File uploads are not configured on this server');
    const dir = path.resolve(ctx.services.filesDir);
    let meta: { name?: string; mime?: string } = {};
    try {
      meta = JSON.parse(await readFile(path.join(dir, `${local[1]}.json`), 'utf8')) as typeof meta;
    } catch {
      throw new EngineError('NOT_FOUND', `Uploaded file ${local[1]} not found`);
    }
    const bytes = await readFile(path.join(dir, `${local[1]}.bin`));
    return { bytes, name: meta.name ?? local[2] ?? local[1]!, mime: meta.mime ?? 'application/octet-stream' };
  }
  if (!/^https?:\/\//i.test(trimmed)) throw new EngineError('BAD_PAYLOAD', `Unsupported file URL "${trimmed.slice(0, 80)}"; use http(s), data: or an uploaded file`);
  let res: Response;
  try {
    res = await ctx.services.fetch(trimmed, { signal: ctx.signal, redirect: 'follow' });
  } catch (e) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    throw new EngineError('NETWORK', `Could not download ${new URL(trimmed).host}: ${(e as Error).message}`, { retryable: true, cause: e });
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new EngineError('UPSTREAM_HTTP', `Downloading ${new URL(trimmed).host} returned ${res.status}`, { retryable: res.status >= 500 || res.status === 429, details: { status: res.status } });
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_FILE_BYTES) throw new EngineError('BAD_PAYLOAD', `File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) throw new EngineError('BAD_PAYLOAD', `File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const name = decodeURIComponent(new URL(res.url || trimmed).pathname.split('/').pop() || 'download');
  return { bytes, name, mime: (res.headers.get('content-type') ?? '').split(';')[0]!.trim() };
}

/* ---------- field spec shorthands ---------- */

export const f = {
  text: (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, type: 'text', ...extra }),
  area: (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, type: 'textarea', ...extra }),
  json: (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, type: 'json', ...extra }),
  num: (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, type: 'number', ...extra }),
  bool: (key: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, type: 'boolean', ...extra }),
  select: (key: string, label: string, options: (string | [string, string])[], extra: Partial<FieldSpec> = {}): FieldSpec => ({
    key, label, type: 'select', options: options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : { value: o, label: o })), ...extra,
  }),
  model: (key = 'generativeModelName', label = 'Model'): FieldSpec => ({ key, label, type: 'model' }),
  embedding: (key = 'embeddingModelName', label = 'Embedding model'): FieldSpec => ({ key, label, type: 'embeddingModel' }),
  credential: (integration: string, key = 'credentials', label = 'Credential'): FieldSpec => ({ key, label, type: 'credential', integration, required: true }),
  vectorDB: (key = 'vectorDB', label = 'Vector database'): FieldSpec => ({ key, label, type: 'vectorDB', required: true }),
};

export const metaOutputs = [{ path: '_meta.total_tokens', type: 'number', description: 'Tokens used' }, { path: '_meta.model_name', type: 'string' }];
