import vm from 'node:vm';
import { EngineError } from '../errors.ts';

export type PathToken =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'slice'; start: number | undefined; end: number | undefined }
  | { kind: 'all' };

export interface TemplateRef {
  raw: string;
  nodeId: string;
  path: PathToken[];
  /** Found inside a JS expression such as `{{a.output.x || 'none'}}`. */
  expression?: boolean;
}

/**
 * Values visible to templates, keyed by root name: node instance ids map to `{ output }`
 * (`{{id.output.x}}`); `secrets` and `env` hold project secrets (`{{secrets.project.NAME}}`) and variables.
 */
export type Scope = ReadonlyMap<string, unknown>;

/** Template roots that are not nodes. */
export const RESERVED_ROOTS = new Set(['secrets', 'env']);

export interface ResolveOptions {
  /** Throw on references that resolve to undefined instead of substituting an empty value. */
  strict: boolean;
  nodeId?: string;
}

const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const IDENT_RE = /^[A-Za-z_$][\w$-]*/;

export function parseRef(expr: string): TemplateRef | null {
  const raw = expr.trim();
  const head = IDENT_RE.exec(raw);
  if (!head) return null;
  const path: PathToken[] = [];
  let i = head[0].length;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '.') {
      const m = IDENT_RE.exec(raw.slice(i + 1)) ?? /^\d+/.exec(raw.slice(i + 1));
      if (!m) return null;
      path.push({ kind: 'key', key: m[0] });
      i += 1 + m[0].length;
    } else if (ch === '[') {
      const close = raw.indexOf(']', i);
      if (close < 0) return null;
      const inner = raw.slice(i + 1, close).trim();
      const quoted = /^(['"])(.*)\1$/.exec(inner);
      if (quoted) path.push({ kind: 'key', key: quoted[2] ?? '' });
      else if (inner === ':') path.push({ kind: 'all' });
      else if (inner.includes(':')) {
        const [a, b] = inner.split(':');
        const start = a?.trim() ? Number(a) : undefined;
        const end = b?.trim() ? Number(b) : undefined;
        if ((start !== undefined && !Number.isInteger(start)) || (end !== undefined && !Number.isInteger(end))) return null;
        path.push({ kind: 'slice', start, end });
      } else if (/^-?\d+$/.test(inner)) path.push({ kind: 'index', index: Number(inner) });
      else return null;
      i = close + 1;
    } else {
      return null;
    }
  }
  return { raw, nodeId: head[0], path };
}

export function getPath(value: unknown, path: readonly PathToken[]): unknown {
  let cur: unknown = value;
  for (let i = 0; i < path.length; i++) {
    const tok = path[i]!;
    if (cur === null || cur === undefined) return undefined;
    switch (tok.kind) {
      case 'key':
        if (typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[tok.key];
        break;
      case 'index': {
        if (!Array.isArray(cur)) return undefined;
        cur = cur.at(tok.index);
        break;
      }
      case 'slice':
        if (!Array.isArray(cur)) return undefined;
        cur = cur.slice(tok.start, tok.end);
        break;
      case 'all': {
        if (!Array.isArray(cur)) return undefined;
        const rest = path.slice(i + 1);
        return cur.map((item) => getPath(item, rest));
      }
    }
  }
  return cur;
}

const EXPR_REF_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*output\b/g;

export function findRefs(text: string): TemplateRef[] {
  const out: TemplateRef[] = [];
  for (const m of text.matchAll(TEMPLATE_RE)) {
    const ref = parseRef(m[1] ?? '');
    if (ref) out.push(ref);
    else for (const e of (m[1] ?? '').matchAll(EXPR_REF_RE)) out.push({ raw: m[1]!.trim(), nodeId: e[1]!, path: [{ kind: 'key', key: 'output' }], expression: true });
  }
  return out;
}

/** Every template reference anywhere inside a (possibly nested) config value. */
export function collectRefs(value: unknown, out: TemplateRef[] = []): TemplateRef[] {
  if (typeof value === 'string') out.push(...findRefs(value));
  else if (Array.isArray(value)) for (const v of value) collectRefs(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectRefs(v, out);
  return out;
}

export function lookup(ref: TemplateRef, scope: Scope): unknown {
  const entry = scope.get(ref.nodeId);
  if (!entry) return undefined;
  return getPath(entry, ref.path);
}

function unresolved(ref: TemplateRef, opts: ResolveOptions): EngineError {
  return new EngineError('TEMPLATE_UNRESOLVED', `Reference {{${ref.raw}}} resolved to undefined`, {
    nodeId: opts.nodeId,
    details: { ref: ref.raw },
  });
}

const IDENT_ONLY = /^[A-Za-z_$][\w$]*$/;

/**
 * Evaluates a template expression such as `{{a.output.x == 'y' ? 'z' : 'w'}}` in a separate realm.
 * Only JSON copies of the referenced values enter that realm, so no host object is reachable from it.
 */
export function evaluateExpression(expr: string, scope: Scope, opts: ResolveOptions): unknown {
  const names = new Set<string>();
  for (const m of expr.matchAll(/[A-Za-z_$][\w$]*/g)) if (scope.has(m[0])) names.add(m[0]);
  const data: Record<string, unknown> = {};
  for (const name of names) if (IDENT_ONLY.test(name)) data[name] = scope.get(name);
  try {
    const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    context['__data'] = JSON.stringify(data);
    const result = vm.runInContext(
      `(() => { const __v = JSON.parse(__data); with (__v) { const __r = (${expr}\n); return __r === undefined ? undefined : JSON.stringify(__r); } })()`,
      context, { timeout: 100, displayErrors: false },
    ) as string | undefined;
    return result === undefined ? undefined : JSON.parse(result);
  } catch (e) {
    throw new EngineError('TEMPLATE_UNRESOLVED', `Template expression {{${expr}}} failed: ${(e as Error)?.message ?? String(e)}`, { nodeId: opts.nodeId, details: { expression: expr } });
  }
}

/** Resolves one `{{...}}` body: a reference path or, failing that, an expression. */
function resolveInner(expr: string, scope: Scope, opts: ResolveOptions): { found: boolean; value: unknown; ref?: TemplateRef } {
  const ref = parseRef(expr);
  // A bare name that is not in scope (`{{language}}` in a prompt file) is placeholder text, not a reference.
  if (ref && ref.path.length === 0 && !scope.has(ref.nodeId)) return { found: false, value: undefined };
  if (ref) return { found: true, value: lookup(ref, scope), ref };
  if (looksLikeExpression(expr)) return { found: true, value: evaluateExpression(expr, scope, opts) };
  return { found: false, value: undefined };
}

/** Plain prose inside braces (e.g. handlebars-like placeholders in prompts) is left untouched. */
function looksLikeExpression(expr: string): boolean {
  return /(?<![\w$.])[A-Za-z_$][\w$]*\s*\.\s*output\b/.test(expr) || /(?<![\w$.])(secrets|env)\./.test(expr);
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  return JSON.stringify(v) ?? '';
}

export function resolveString(text: string, scope: Scope, opts: ResolveOptions): unknown {
  const whole = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/.exec(text);
  if (whole) {
    const r = resolveInner(whole[1] ?? '', scope, opts);
    if (r.found) {
      if (r.value === undefined && opts.strict && r.ref) throw unresolved(r.ref, opts);
      return r.value;
    }
  }
  return text.replace(TEMPLATE_RE, (match, expr: string) => {
    const r = resolveInner(expr, scope, opts);
    if (!r.found) return match;
    if (r.value === undefined && opts.strict && r.ref) throw unresolved(r.ref, opts);
    return stringify(r.value);
  });
}

export function resolveValue(value: unknown, scope: Scope, opts: ResolveOptions): unknown {
  if (typeof value === 'string') return resolveString(value, scope, opts);
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, scope, opts));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, scope, opts);
    return out;
  }
  return value;
}

/**
 * Turns a JSON template (e.g. a response node's `outputMapping`) into a value WITHOUT
 * string-splicing resolved values into JSON text. Templates outside JSON strings
 * (`{"n": {{x.output.count}}}`) are swapped for sentinels before parsing, so the template
 * stays parseable and resolved values can never change the JSON structure.
 */
export function parseJsonTemplate(text: string): unknown {
  const sentinels: string[] = [];
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '{' && text[i + 1] === '{') {
      const close = text.indexOf('}}', i + 2);
      if (close > 0) {
        sentinels.push(text.slice(i, close + 2));
        out += JSON.stringify(`\u0000tpl${sentinels.length - 1}\u0000`);
        i = close + 1;
        continue;
      }
    }
    out += ch;
  }
  const parsed: unknown = JSON.parse(out);
  const restore = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = /^\u0000tpl(\d+)\u0000$/.exec(v);
      return m ? sentinels[Number(m[1])] : v;
    }
    if (Array.isArray(v)) return v.map(restore);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restore(x)]));
    return v;
  };
  return restore(parsed);
}

/** Accepts either a JSON-template string (Studio stores these as strings) or an already-parsed object. */
export function resolveJsonTemplate(template: unknown, scope: Scope, opts: ResolveOptions): unknown {
  const parsed = typeof template === 'string' && template.trim() !== '' ? parseJsonTemplate(template) : template;
  return resolveValue(parsed, scope, opts);
}

/** Substitutes templates inside code as JSON literals, so injected values are data, never code. */
export function resolveCode(code: string, scope: Scope, opts: ResolveOptions): string {
  return code.replace(TEMPLATE_RE, (match, expr: string) => {
    const r = resolveInner(expr, scope, opts);
    if (!r.found) return match;
    if (r.value === undefined && opts.strict && r.ref) throw unresolved(r.ref, opts);
    return r.value === undefined ? 'undefined' : JSON.stringify(r.value);
  });
}
