import vm from 'node:vm';
import { EngineError } from '../errors.ts';
import type { Diagnostic, FlowNode } from '../flow/schema.ts';
import { parseJsonTemplate, resolveCode, resolveJsonTemplate, resolveValue, type Scope } from '../flow/template.ts';
import type { LLMMessage } from '../llm/providers.ts';
import { validateJsonSchema } from './jsonschema.ts';
import { NodeRegistry, type NodeContext, type NodeHandler, type NodeOutput } from './types.ts';

const opts = (ctx: NodeContext) => ({ strict: ctx.strictTemplates, nodeId: ctx.nodeId });
const lenient = (ctx: NodeContext) => ({ strict: false, nodeId: ctx.nodeId });

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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

function jsonDiagnostic(node: FlowNode, field: string): Diagnostic[] {
  const raw = node.values[field];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    parseJsonTemplate(raw);
    return [];
  } catch (e) {
    return [{ severity: 'error', code: 'INVALID_JSON_TEMPLATE', message: `${field} is not valid JSON: ${(e as Error).message}`, nodeId: node.id }];
  }
}

/* ---------------- triggers ---------------- */

function triggerHandler(type: string): NodeHandler {
  return {
    type,
    kind: 'trigger',
    validate: (node) => jsonDiagnostic(node, 'advance_schema'),
    async run(ctx) {
      const raw = ctx.values['advance_schema'];
      if (typeof raw === 'string' && raw.trim() !== '') {
        const schema = JSON.parse(raw) as Record<string, unknown>;
        // Either a JSON schema, or Studio's flat {field: "type"} map.
        const asSchema = 'properties' in schema || 'type' in schema
          ? schema
          : { type: 'object', required: Object.keys(schema), properties: Object.fromEntries(Object.entries(schema).map(([k, t]) => [k, { type: t }])) };
        const errors = validateJsonSchema(ctx.payload, asSchema);
        if (errors.length) throw new EngineError('BAD_PAYLOAD', `Payload does not match the trigger schema: ${errors.join('; ')}`, { details: errors });
      }
      return { output: ctx.payload ?? {} };
    },
  };
}

/* ---------------- response ---------------- */

function responseHandler(type: string): NodeHandler {
  return {
    type,
    kind: 'response',
    validate: (node) => jsonDiagnostic(node, 'outputMapping'),
    async run(ctx) {
      if (ctx.values['outputMapping'] !== undefined && ctx.values['outputMapping'] !== '') {
        return { output: resolveJsonTemplate(ctx.values['outputMapping'], ctx.scope, opts(ctx)) };
      }
      if (ctx.values['content'] !== undefined) return { output: { content: resolveValue(ctx.values['content'], ctx.scope, opts(ctx)) } };
      return { output: {} };
    },
  };
}

/* ---------------- condition ---------------- */

interface ConditionGroup {
  operator?: string | null;
  operands?: (ConditionGroup | ConditionLeaf)[];
}
interface ConditionLeaf {
  name?: unknown;
  operator?: string;
  value?: unknown;
}
interface ConditionEntry {
  label?: string;
  value?: string;
  condition?: unknown;
}

const looseEq = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a !== 'object' && typeof b !== 'object' && a !== '' && b !== '' && a != null && b != null && !Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  if (a && typeof a === 'object') return JSON.stringify(a) === (typeof b === 'string' ? b : JSON.stringify(b));
  return String(a ?? '') === String(b ?? '');
};
const isEmpty = (a: unknown) => a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0) || (typeof a === 'object' && a !== null && Object.keys(a).length === 0);
const num = (f: (x: number, y: number) => boolean) => (a: unknown, b: unknown) => {
  const x = Number(a);
  const y = Number(b);
  return !Number.isNaN(x) && !Number.isNaN(y) && f(x, y);
};
const contains = (a: unknown, b: unknown) => (Array.isArray(a) ? a.some((x) => looseEq(x, b)) : String(a ?? '').includes(String(b ?? '')));

const OPERATORS: Record<string, (a: unknown, b: unknown) => boolean> = {
  '==': looseEq, '===': looseEq, 'equals': looseEq,
  '!=': (a, b) => !looseEq(a, b), '!==': (a, b) => !looseEq(a, b), 'notEquals': (a, b) => !looseEq(a, b),
  '>': num((x, y) => x > y), '<': num((x, y) => x < y), '>=': num((x, y) => x >= y), '<=': num((x, y) => x <= y),
  'contains': contains, 'notContains': (a, b) => !contains(a, b), 'not contains': (a, b) => !contains(a, b),
  'startsWith': (a, b) => String(a ?? '').startsWith(String(b ?? '')), 'starts with': (a, b) => String(a ?? '').startsWith(String(b ?? '')),
  'endsWith': (a, b) => String(a ?? '').endsWith(String(b ?? '')), 'ends with': (a, b) => String(a ?? '').endsWith(String(b ?? '')),
  'isEmpty': (a) => isEmpty(a), 'is empty': (a) => isEmpty(a),
  'isNotEmpty': (a) => !isEmpty(a), 'is not empty': (a) => !isEmpty(a),
};

function parseCondition(raw: unknown): ConditionGroup | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!value || typeof value !== 'object' || Object.keys(value).length === 0) return null;
  return value as ConditionGroup;
}

function conditionErrors(group: ConditionGroup | ConditionLeaf): string[] {
  if ('operands' in group && Array.isArray(group.operands)) {
    const op = (group as ConditionGroup).operator;
    const errs = op == null || /^(and|or)$/i.test(op) ? [] : [`unknown combinator "${op}"`];
    return errs.concat(group.operands.flatMap(conditionErrors));
  }
  const leaf = group as ConditionLeaf;
  return leaf.operator && OPERATORS[leaf.operator] ? [] : [`unknown operator "${leaf.operator}"`];
}

function evaluate(group: ConditionGroup | ConditionLeaf, scope: Scope, ctx: NodeContext): boolean {
  if ('operands' in group && Array.isArray(group.operands)) {
    const results = group.operands.map((o) => evaluate(o, scope, ctx));
    return /^or$/i.test((group as ConditionGroup).operator ?? '') ? results.some(Boolean) : results.every(Boolean);
  }
  const leaf = group as ConditionLeaf;
  // Conditions often test for missing values, so they resolve leniently even in strict mode.
  const left = resolveValue(leaf.name, scope, lenient(ctx));
  const right = resolveValue(leaf.value, scope, lenient(ctx));
  return OPERATORS[leaf.operator ?? '']!(left, right);
}

const conditionEntries = (node: FlowNode): ConditionEntry[] =>
  Array.isArray(node.values['conditions']) ? (node.values['conditions'] as ConditionEntry[]) : [];

const conditionHandler: NodeHandler = {
  type: 'conditionNode',
  kind: 'condition',
  branchKeys: (node) => conditionEntries(node).map((c) => c.value).filter((v): v is string => typeof v === 'string'),
  validate(node) {
    const out: Diagnostic[] = [];
    const entries = conditionEntries(node);
    if (entries.length === 0) out.push({ severity: 'error', code: 'CONDITION_INVALID', message: 'Condition node has no conditions', nodeId: node.id });
    for (const c of entries) {
      try {
        const group = parseCondition(c.condition);
        for (const msg of group ? conditionErrors(group) : []) out.push({ severity: 'error', code: 'CONDITION_INVALID', message: `${c.label ?? c.value}: ${msg}`, nodeId: node.id });
      } catch (e) {
        out.push({ severity: 'error', code: 'CONDITION_INVALID', message: `${c.label ?? c.value}: condition is not valid JSON (${(e as Error).message})`, nodeId: node.id });
      }
    }
    return out;
  },
  async run(ctx) {
    const entries = conditionEntries(ctx.node);
    const multiple = ctx.values['allowMultipleConditionExecution'] === true;
    const matched: ConditionEntry[] = [];
    let elseEntry: ConditionEntry | undefined;
    for (const c of entries) {
      const group = parseCondition(c.condition);
      if (!group) {
        elseEntry ??= c;
        continue;
      }
      if (evaluate(group, ctx.scope, ctx)) {
        matched.push(c);
        if (!multiple) break;
      }
    }
    const chosen = matched.length ? matched : elseEntry ? [elseEntry] : [];
    const labels = chosen.map((c) => c.label ?? c.value ?? '');
    return {
      output: { condition: multiple ? labels : (labels[0] ?? null) },
      branches: chosen.map((c) => c.value).filter((v): v is string => typeof v === 'string'),
    };
  },
};

/* ---------------- code ---------------- */

const CODE_LIMIT = 10_000;
const FORBIDDEN_CODE = /\brequire\s*\(|\beval\s*\(|\bFunction\s*\(|child_process|\bimport\s*\(|\bprocess\s*\./;

const codeHandler: NodeHandler = {
  type: 'codeNode',
  kind: 'action',
  validate(node) {
    const code = node.values['code'];
    if (typeof code !== 'string' || code.trim() === '') return [{ severity: 'error', code: 'CODE_MISSING', message: 'Code node has no code', nodeId: node.id }];
    const out: Diagnostic[] = [];
    if (code.length > CODE_LIMIT) out.push({ severity: 'error', code: 'CODE_TOO_LARGE', message: `Code is ${code.length} characters; the limit is ${CODE_LIMIT}`, nodeId: node.id });
    if (FORBIDDEN_CODE.test(code)) out.push({ severity: 'error', code: 'CODE_FORBIDDEN', message: 'Code uses require/eval/Function/dynamic import/process, which are blocked', nodeId: node.id });
    try {
      new vm.Script(`(async () => {\n${resolvePlaceholders(code)}\n})`);
    } catch (e) {
      out.push({ severity: 'error', code: 'CODE_SYNTAX', message: (e as Error).message, nodeId: node.id });
    }
    return out;
  },
  async run(ctx) {
    const code = resolveCode(String(ctx.values['code'] ?? ''), ctx.scope, opts(ctx));
    const sandbox: Record<string, unknown> = { output: undefined, console: { log() {}, warn() {}, error() {} } };
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    let returned: unknown;
    try {
      const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: `${ctx.nodeId}.js` });
      returned = await abortable(script.runInContext(context, { timeout: ctx.services.codeTimeoutMs }) as Promise<unknown>, ctx.signal);
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      throw new EngineError('CODE_ERROR', `Code node failed: ${(e as Error)?.message ?? String(e)}`, { cause: e });
    }
    // Lamatic code nodes assign to `output`; a plain `return` is accepted too.
    return { output: structuredClone(sandbox['output'] !== undefined ? sandbox['output'] : returned) };
  },
};

/** Templates inside code are substituted at run time; for syntax checks, stand in a literal. */
function resolvePlaceholders(code: string): string {
  return code.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, 'null');
}

/* ---------------- LLM ---------------- */

interface ModelChoice {
  provider: string | undefined;
  model: string | undefined;
}

function modelChoice(raw: unknown): ModelChoice {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first === 'string') return { provider: undefined, model: first };
  if (first && typeof first === 'object') {
    const o = first as Record<string, unknown>;
    const model = o['model_name'] ?? o['model'] ?? o['modelName'];
    const provider = o['provider_name'] ?? o['provider'];
    return { provider: typeof provider === 'string' ? provider : undefined, model: typeof model === 'string' ? model : undefined };
  }
  return { provider: undefined, model: undefined };
}

function promptMessages(ctx: NodeContext): LLMMessage[] {
  const prompts = Array.isArray(ctx.values['prompts']) ? (ctx.values['prompts'] as { role?: unknown; content?: unknown }[]) : [];
  return prompts.map((p) => ({
    role: p.role === 'system' || p.role === 'assistant' ? p.role : 'user',
    content: String(resolveValue(p.content ?? '', ctx.scope, opts(ctx)) ?? ''),
  }));
}

function llmValidate(node: FlowNode): Diagnostic[] {
  const prompts = node.values['prompts'];
  if (!Array.isArray(prompts) || prompts.length === 0) return [{ severity: 'error', code: 'LLM_NO_PROMPT', message: 'LLM node has no prompts', nodeId: node.id }];
  return [];
}

async function callLLM(ctx: NodeContext, jsonSchema?: Record<string, unknown>) {
  const choice = modelChoice(ctx.values['generativeModelName']);
  const provider = ctx.services.llm.provider(choice.provider);
  const maxTokens = Number(ctx.values['max_tokens'] ?? ctx.values['maxTokens']);
  return provider.generate({
    model: choice.model ?? ctx.services.llm.defaultModel,
    messages: promptMessages(ctx),
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    ...(jsonSchema ? { jsonSchema } : {}),
    signal: ctx.signal,
  });
}

const llmHandler: NodeHandler = {
  type: 'LLMNode',
  kind: 'action',
  validate: llmValidate,
  async run(ctx): Promise<NodeOutput> {
    const res = await callLLM(ctx);
    return { output: { generatedResponse: res.text }, usage: { llmCalls: 1, inputTokens: res.inputTokens, outputTokens: res.outputTokens } };
  },
};

const instructorHandler: NodeHandler = {
  type: 'InstructorLLMNode',
  kind: 'action',
  validate(node) {
    const out = llmValidate(node);
    try {
      const s = node.values['schema'];
      if (typeof s === 'string') JSON.parse(s);
      else if (!s || typeof s !== 'object') out.push({ severity: 'error', code: 'SCHEMA_MISSING', message: 'Structured-output node needs a JSON schema', nodeId: node.id });
    } catch (e) {
      out.push({ severity: 'error', code: 'SCHEMA_INVALID', message: `schema is not valid JSON: ${(e as Error).message}`, nodeId: node.id });
    }
    return out;
  },
  async run(ctx) {
    const raw = ctx.values['schema'];
    const schema = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    const res = await callLLM(ctx, schema);
    const usage = { llmCalls: 1, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw new EngineError('OUTPUT_SCHEMA', 'Model output is not valid JSON', { retryable: true, details: { usage } });
    }
    const errors = validateJsonSchema(parsed, schema);
    if (errors.length) throw new EngineError('OUTPUT_SCHEMA', `Model output does not match the schema: ${errors.slice(0, 5).join('; ')}`, { retryable: true, details: { errors, usage } });
    return { output: parsed, usage };
  },
};

/* ---------------- API ---------------- */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const methodOf = (node: FlowNode) => String(node.values['method'] ?? 'GET').toUpperCase();

const apiHandler: NodeHandler = {
  type: 'apiNode',
  kind: 'action',
  sideEffect: (node) => !SAFE_METHODS.has(methodOf(node)),
  idempotent: (node) => SAFE_METHODS.has(methodOf(node)) || node.values['idempotent'] === true,
  validate(node) {
    const out = [...jsonDiagnostic(node, 'headers')];
    if (typeof node.values['url'] !== 'string' || node.values['url'] === '') out.push({ severity: 'error', code: 'API_NO_URL', message: 'API node has no url', nodeId: node.id });
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(methodOf(node))) out.push({ severity: 'error', code: 'API_METHOD', message: `Unsupported method ${methodOf(node)}`, nodeId: node.id });
    return out;
  },
  async run(ctx) {
    const method = methodOf(ctx.node);
    const url = String(resolveValue(ctx.values['url'], ctx.scope, opts(ctx)));
    const rawHeaders = ctx.values['headers'];
    const headers = rawHeaders ? (resolveJsonTemplate(rawHeaders, ctx.scope, opts(ctx)) as Record<string, string>) : {};
    const rawBody = ctx.values['body'];
    let body: string | undefined;
    if (rawBody !== undefined && rawBody !== '' && !SAFE_METHODS.has(method)) {
      const trimmed = typeof rawBody === 'string' ? rawBody.trim() : '';
      if (typeof rawBody === 'object' || trimmed.startsWith('{') || trimmed.startsWith('[')) {
        body = JSON.stringify(resolveJsonTemplate(rawBody, ctx.scope, opts(ctx)));
        headers['content-type'] ??= 'application/json';
      } else body = String(resolveValue(rawBody, ctx.scope, opts(ctx)));
    }
    if (!SAFE_METHODS.has(method)) headers['Idempotency-Key'] ??= ctx.idempotencyKey;
    let res: Response;
    try {
      res = await ctx.services.fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: ctx.signal });
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      throw new EngineError('NETWORK', `Request to ${new URL(url).host} failed: ${(e as Error).message}`, { retryable: true, cause: e });
    }
    const text = await res.text();
    let data: unknown = text;
    if ((res.headers.get('content-type') ?? '').includes('json') && text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const code = res.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_HTTP';
      throw new EngineError(code, `${method} ${new URL(url).host} returned ${res.status}`, {
        retryable: res.status === 429 || res.status >= 500 || res.status === 408,
        details: { status: res.status, body: text.slice(0, 500) },
      });
    }
    return { output: data };
  },
};

/* ---------------- variables ---------------- */

function coerce(value: unknown, type: unknown): unknown {
  switch (type) {
    case 'number': return typeof value === 'number' ? value : Number(value);
    case 'boolean': return value === true || value === 'true';
    case 'object':
    case 'array':
      if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { return value; }
      }
      return value;
    case 'string': return typeof value === 'string' ? value : JSON.stringify(value);
    default: return value;
  }
}

const variablesHandler: NodeHandler = {
  type: 'variablesNode',
  kind: 'action',
  validate: (node) => jsonDiagnostic(node, 'mapping'),
  async run(ctx) {
    const mapping = (resolveJsonTemplate(ctx.values['mapping'] ?? {}, ctx.scope, opts(ctx)) ?? {}) as Record<string, { type?: string; value?: unknown }>;
    const output: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(mapping)) {
      output[name] = spec && typeof spec === 'object' && 'value' in spec ? coerce(spec.value, spec.type) : spec;
    }
    return { output };
  },
};

/* ---------------- loops ---------------- */

const forLoopHandler: NodeHandler = {
  type: 'forLoopNode',
  kind: 'loopStart',
  validate(node) {
    const mode = node.values['iterateOver'] ?? 'list';
    if (mode !== 'list' && mode !== 'range') return [{ severity: 'error', code: 'LOOP_MODE', message: `iterateOver must be "list" or "range", got ${String(mode)}`, nodeId: node.id }];
    return [];
  },
  async iterate(ctx) {
    const waitMs = Math.min(Math.max(Number(ctx.values['wait'] ?? 0), 0), 30) * 1000;
    if ((ctx.values['iterateOver'] ?? 'list') === 'range') {
      const start = Number(resolveValue(ctx.values['initialValue'] ?? 0, ctx.scope, opts(ctx)));
      const end = Number(resolveValue(ctx.values['endValue'] ?? 0, ctx.scope, opts(ctx)));
      const step = Number(resolveValue(ctx.values['increment'] ?? 1, ctx.scope, opts(ctx)));
      if (![start, end, step].every(Number.isFinite) || step === 0) throw new EngineError('BAD_PAYLOAD', 'Loop range needs finite start/end and a non-zero increment');
      const items: number[] = [];
      for (let i = start; step > 0 ? i < end : i > end; i += step) {
        items.push(i);
        if (items.length > 100_000) break;
      }
      return { items, waitMs };
    }
    const list = resolveValue(ctx.values['iteratorValue'], ctx.scope, opts(ctx));
    if (!Array.isArray(list)) throw new EngineError('BAD_PAYLOAD', `Loop iteratorValue must resolve to an array, got ${list === null ? 'null' : typeof list}`);
    return { items: list, waitMs };
  },
  async run() {
    throw new EngineError('INTERNAL', 'forLoopNode is driven by the executor');
  },
};

const forLoopEndHandler: NodeHandler = {
  type: 'forLoopEndNode',
  kind: 'loopEnd',
  async run() {
    throw new EngineError('INTERNAL', 'forLoopEndNode is driven by the executor');
  },
};

export function defaultRegistry(): NodeRegistry {
  return new NodeRegistry([
    triggerHandler('graphqlNode'),
    triggerHandler('webhookTriggerNode'),
    triggerHandler('chatTriggerNode'),
    triggerHandler('cronNode'),
    responseHandler('graphqlResponseNode'),
    responseHandler('chatResponseNode'),
    conditionHandler,
    codeHandler,
    llmHandler,
    instructorHandler,
    apiHandler,
    variablesHandler,
    forLoopHandler,
    forLoopEndHandler,
  ]);
}
