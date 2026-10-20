import vm from 'node:vm';
import { setTimeout as sleep } from 'node:timers/promises';
import { EngineError } from '../errors.ts';
import type { Diagnostic, FlowNode } from '../flow/schema.ts';
import { resolveCode, resolveJsonTemplate, resolveValue, type Scope } from '../flow/template.ts';
import { xmlToJson } from '../integrations/xml.ts';
import { validateJsonSchema } from './jsonschema.ts';
import { eraseTypes, runCodeInWorker, TEMPLATE_IN_CODE } from './code-worker-runner.ts';
import { bool, f, jsonDiagnostic, jsonField, jsonish, lenient, num, opts, required, str, val } from './common.ts';
import type { NodeContext, NodeHandler, NodeSpec } from './types.ts';

/* ---------------- triggers ---------------- */

/** Studio's flat `advance_schema` ({"q":"string","tags":"[string]","order":{"id":"number"}}) as JSON schema. */
export function flatSchemaToJsonSchema(spec: unknown): Record<string, unknown> {
  if (typeof spec === 'string') {
    const t = spec.trim();
    const arr = /^\[(.*)\]$/.exec(t);
    if (arr) return { type: 'array', items: flatSchemaToJsonSchema(arr[1] || 'any') };
    return ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(t) ? { type: t } : {};
  }
  if (Array.isArray(spec)) return { type: 'array', ...(spec[0] !== undefined ? { items: flatSchemaToJsonSchema(spec[0]) } : {}) };
  if (spec && typeof spec === 'object') {
    return { type: 'object', properties: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, flatSchemaToJsonSchema(v)])) };
  }
  return {};
}

function payloadSchema(raw: unknown): Record<string, unknown> | undefined {
  const value = jsonish(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) return undefined;
  const schema = value as Record<string, unknown>;
  if (('properties' in schema && typeof schema['properties'] === 'object') || schema['type'] === 'object') return schema;
  return { ...flatSchemaToJsonSchema(schema), required: Object.keys(schema) };
}

interface TriggerOptions {
  label: string;
  description: string;
  icon: string;
  fields?: NodeSpec['fields'];
  outputs?: NodeSpec['outputs'];
  defaults?: Record<string, unknown>;
  normalize?: (payload: Record<string, unknown>) => Record<string, unknown>;
}

function triggerHandler(type: string, o: TriggerOptions): NodeHandler {
  return {
    type,
    kind: 'trigger',
    spec: {
      label: o.label, category: 'trigger', description: o.description, icon: o.icon, rfType: 'triggerNode',
      fields: o.fields ?? [], outputs: o.outputs ?? [],
      defaults: () => ({ nodeName: o.label, ...structuredClone(o.defaults ?? {}) }),
    },
    validate(node) {
      const raw = node.values['advance_schema'];
      if (typeof raw !== 'string' || raw.trim() === '') return [];
      try {
        JSON.parse(raw);
        return [];
      } catch (e) {
        return [{ severity: 'error', code: 'INVALID_JSON_TEMPLATE', message: `advance_schema is not valid JSON: ${(e as Error).message}`, nodeId: node.id }];
      }
    },
    async run(ctx) {
      const payload = (ctx.payload && typeof ctx.payload === 'object' && !Array.isArray(ctx.payload) ? ctx.payload : {}) as Record<string, unknown>;
      const schema = payloadSchema(ctx.values['advance_schema']);
      if (schema) {
        const errors = validateJsonSchema(payload, schema);
        if (errors.length) throw new EngineError('BAD_PAYLOAD', `Invalid trigger payload: ${errors.join('; ')}`, { details: errors });
      }
      return { output: o.normalize ? o.normalize(payload) : payload };
    },
  };
}

const schemaField = f.json('advance_schema', 'Input schema', { help: 'Expected payload fields, e.g. {"question": "string", "tags": "[string]"}. Requests that do not match are rejected with 400.' });
const modeField = f.select('responeType', 'Response mode', [['realtime', 'Realtime (wait for the result)'], ['async', 'Async (return a requestId; poll checkStatus)']]);

const chatNormalize = (p: Record<string, unknown>) => {
  const chatMessage = p['chatMessage'] ?? p['message'] ?? p['query'] ?? '';
  const history = Array.isArray(p['chatHistory']) ? p['chatHistory'] : [];
  return { ...p, chatMessage, message: chatMessage, chatHistory: history, sessionId: p['sessionId'] ?? '', userId: p['userId'] ?? '' };
};

const triggers: NodeHandler[] = [
  triggerHandler('graphqlNode', {
    label: 'API Request', icon: 'api', description: 'Run the flow from the GraphQL or REST API with a JSON payload.',
    fields: [modeField, schemaField], defaults: { responeType: 'realtime', advance_schema: '{\n  "question": "string"\n}' },
    outputs: [{ path: '<field>', type: 'any', description: 'Each payload field' }],
  }),
  triggerHandler('mailhookNode', {label:'Inbound Email',icon:'mail',description:'Receive email through the local SMTP ingress.',fields:[],defaults:{},outputs:[{path:'from',type:'string'},{path:'to',type:'string'},{path:'subject',type:'string'},{path:'text',type:'string'},{path:'html',type:'string'},{path:'attachments',type:'array'}]}),
  triggerHandler('webhookTriggerNode', {
    label: 'Webhook', icon: 'webhook', description: 'Run the flow when JSON is POSTed to its webhook URL.',
    fields: [schemaField, f.text('webhookSecret', 'Shared secret', { help: 'When set, callers must send it in the x-jasmine-signature header (or ?secret=).', advanced: true })],
    defaults: { advance_schema: '' }, outputs: [{ path: '<field>', type: 'any', description: 'The POSTed JSON body' }],
  }),
  triggerHandler('chatTriggerNode', {
    label: 'Chat Widget', icon: 'chat', description: 'Run the flow for every message sent to the embeddable chat widget.',
    fields: [{ key: 'chatConfig', label: 'Widget appearance', type: 'chatConfig' }, { key: 'domains', label: 'Allowed domains', type: 'stringList', help: 'Origins allowed to embed the widget; * allows any.' }],
    defaults: { chat: '', domains: ['*'], chatConfig: { botName: 'Jasmine', greetingMessage: 'Hi! How can I help?', suggestions: [], colors: { primary: '#5b5bd6', secondary: '#ffffff' } } },
    outputs: [{ path: 'chatMessage', type: 'string' }, { path: 'chatHistory', type: 'array' }, { path: 'sessionId', type: 'string' }, { path: 'userId', type: 'string' }],
    normalize: chatNormalize,
  }),
  triggerHandler('searchTriggerNode', {
    label: 'Search Widget', icon: 'search', description: 'Run the flow for each query typed into the embeddable search widget.',
    fields: [{ key: 'domains', label: 'Allowed domains', type: 'stringList' }], defaults: { search: '', domains: ['*'], searchConfig: {} },
    outputs: [{ path: 'searchQuery', type: 'string' }],
    normalize: (p) => ({ ...p, searchQuery: p['searchQuery'] ?? p['query'] ?? '' }),
  }),
  triggerHandler('askTriggerNode', {
    label: 'Ask Widget', icon: 'ask', description: 'Question-answering widget with follow-ups.',
    fields: [{ key: 'domains', label: 'Allowed domains', type: 'stringList' }], defaults: { domains: ['*'], askConfig: {} },
    outputs: [{ path: 'message', type: 'string' }, { path: 'conversationId', type: 'string' }],
    normalize: (p) => ({ ...p, message: p['message'] ?? p['chatMessage'] ?? '', conversationId: p['conversationId'] ?? '' }),
  }),
  triggerHandler('cronNode', {
    label: 'Schedule', icon: 'clock', description: 'Run the deployed flow on a cron schedule.',
    fields: [{ key: 'cronExpression', label: 'Cron expression', type: 'cron', required: true, help: 'minute hour day month weekday, e.g. "0 9 * * 1-5"' }, f.text('cronTimezone', 'Time zone', { placeholder: 'UTC' }), f.json('cronPayload', 'Payload', { advanced: true })],
    defaults: { cronExpression: '0 9 * * *', cronTimezone: 'UTC' },
    outputs: [{ path: 'scheduledAt', type: 'string' }, { path: 'firedAt', type: 'string' }],
  }),
  triggerHandler('localFolderNode', {
    label: 'Local Folder', icon: 'folder', description: 'Run the flow once for every new or changed file in a folder (incremental sync), e.g. to keep a knowledge base current.',
    fields: [
      f.text('folderPath', 'Folder', { required: true, placeholder: '/home/me/Documents/handbook' }),
      { key: 'globs', label: 'File patterns', type: 'stringList', help: 'e.g. **/*.pdf, **/*.md' },
      { key: 'cronExpression', label: 'Check every', type: 'cron', help: 'Cron schedule for the sync, e.g. */15 * * * *' },
      f.bool('recursive', 'Include subfolders'), f.num('maxFiles', 'Files per sync', { advanced: true }),
    ],
    defaults: { folderPath: '', globs: ['**/*.{pdf,md,txt,docx,html}'], cronExpression: '*/15 * * * *', recursive: true, maxFiles: 100 },
    outputs: [{ path: 'content', type: 'string', description: 'Extracted text' }, { path: 'document_key', type: 'string', description: 'Path relative to the folder' },
      { path: 'document_name', type: 'string' }, { path: 'document_id', type: 'string' }, { path: 'document_url', type: 'string' }, { path: 'modified', type: 'string' }],
  }),
];

/* ---------------- responses ---------------- */

function responseSpec(label: string, description: string, fields: NodeSpec['fields'], defaults: Record<string, unknown>): NodeSpec {
  return { label, category: 'response', description, icon: 'response', rfType: 'responseNode', fields, outputs: [], defaults: () => ({ nodeName: label, ...structuredClone(defaults) }) };
}

const graphqlResponse: NodeHandler = {
  type: 'graphqlResponseNode',
  kind: 'response',
  spec: responseSpec('API Response', 'Shape the JSON returned to the API caller.', [
    f.json('outputMapping', 'Output mapping', { help: 'JSON returned to the caller; reference upstream outputs with {{node.output.field}}.', required: true }),
    f.json('headers', 'Response headers', { advanced: true }),
  ], { outputMapping: '{\n  "answer": ""\n}', headers: '{"content-type":"application/json"}' }),
  validate: (node) => jsonDiagnostic(node, 'outputMapping'),
  async run(ctx) {
    if (ctx.values['outputMapping'] !== undefined && ctx.values['outputMapping'] !== '') {
      return { output: resolveJsonTemplate(ctx.values['outputMapping'], ctx.scope, opts(ctx)) };
    }
    if (ctx.values['content'] !== undefined) return { output: { content: resolveValue(ctx.values['content'], ctx.scope, opts(ctx)) } };
    return { output: {} };
  },
};

const chatResponse: NodeHandler = {
  type: 'chatResponseNode',
  kind: 'response',
  spec: responseSpec('Chat Response', 'Send the reply (and optional references) back to the chat widget.', [
    f.area('content', 'Message', { required: true }),
    f.text('references', 'References', { help: 'Optional list of sources shown under the reply.', advanced: true }),
  ], { content: '' }),
  async run(ctx) {
    const content = val(ctx, 'content', '');
    const references = val(ctx, 'references', undefined, false);
    return { output: { content: typeof content === 'string' ? content : str(content), ...(references !== undefined ? { references: jsonish(references) } : {}) } };
  },
};

const askResponse: NodeHandler = {
  ...chatResponse,
  type: 'askResponseNode',
  spec: responseSpec('Ask Response', 'Answer (and sources) for the ask widget.', chatResponse.spec!.fields, { content: '' }),
};

const SEARCH_FIELDS = ['title', 'content', 'link', 'tab', 'group', 'breadcrumpsField', 'referenceLink', 'referenceText'] as const;
const searchResponse: NodeHandler = {
  type: 'searchResponseNode',
  kind: 'response',
  spec: responseSpec('Search Response', 'Return search results to the search widget. Map each field to a list, e.g. {{search.output.searchResults[:].title}}.',
    SEARCH_FIELDS.map((k) => f.text(k, k === 'breadcrumpsField' ? 'Breadcrumbs' : k[0]!.toUpperCase() + k.slice(1))), { title: '', content: '', link: '' }),
  async run(ctx) {
    const columns = Object.fromEntries(SEARCH_FIELDS.map((k) => [k, val(ctx, k, undefined, false)]));
    const length = Math.max(0, ...Object.values(columns).map((v) => (Array.isArray(v) ? v.length : v === undefined ? 0 : 1)));
    const results = Array.from({ length }, (_, i) => Object.fromEntries(
      Object.entries(columns).filter(([, v]) => v !== undefined).map(([k, v]) => [k === 'breadcrumpsField' ? 'breadcrumbs' : k, Array.isArray(v) ? v[i] : v]),
    ));
    return { output: { results } };
  },
};

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
const numCmp = (fn: (x: number, y: number) => boolean) => (a: unknown, b: unknown) => {
  const x = Number(a);
  const y = Number(b);
  return !Number.isNaN(x) && !Number.isNaN(y) && fn(x, y);
};
const contains = (a: unknown, b: unknown) => (Array.isArray(a) ? a.some((x) => looseEq(x, b)) : String(a ?? '').includes(String(b ?? '')));
const like = (insensitive: boolean) => (a: unknown, b: unknown) => {
  const pattern = String(b ?? '');
  const text = String(a ?? '');
  if (!/[%_]/.test(pattern)) return insensitive ? text.toLowerCase().includes(pattern.toLowerCase()) : text.includes(pattern);
  const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, insensitive ? 'is' : 's');
  return re.test(text);
};
const truthy = (a: unknown) => a === true || a === 'true' || (typeof a === 'number' && a !== 0);

export const OPERATORS: Record<string, (a: unknown, b: unknown) => boolean> = {
  '==': looseEq, '===': looseEq, 'equals': looseEq, 'eq': looseEq,
  '!=': (a, b) => !looseEq(a, b), '!==': (a, b) => !looseEq(a, b), 'notEquals': (a, b) => !looseEq(a, b), 'ne': (a, b) => !looseEq(a, b),
  '>': numCmp((x, y) => x > y), '<': numCmp((x, y) => x < y), '>=': numCmp((x, y) => x >= y), '<=': numCmp((x, y) => x <= y),
  'contains': contains, 'notContains': (a, b) => !contains(a, b), 'not contains': (a, b) => !contains(a, b),
  'startsWith': (a, b) => String(a ?? '').startsWith(String(b ?? '')), 'starts with': (a, b) => String(a ?? '').startsWith(String(b ?? '')),
  'endsWith': (a, b) => String(a ?? '').endsWith(String(b ?? '')), 'ends with': (a, b) => String(a ?? '').endsWith(String(b ?? '')),
  'isEmpty': (a) => isEmpty(a), 'is empty': (a) => isEmpty(a),
  'isNotEmpty': (a) => !isEmpty(a), 'is not empty': (a) => !isEmpty(a),
  'like': like(false), 'ilike': like(true), 'not like': (a, b) => !like(false)(a, b), 'not ilike': (a, b) => !like(true)(a, b),
  'in': (a, b) => (Array.isArray(jsonish(b)) ? (jsonish(b) as unknown[]).some((x) => looseEq(a, x)) : contains(b, a)),
  'notIn': (a, b) => !(Array.isArray(jsonish(b)) ? (jsonish(b) as unknown[]).some((x) => looseEq(a, x)) : contains(b, a)),
  'isTrue': (a) => truthy(a), 'is true': (a) => truthy(a), 'isFalse': (a) => !truthy(a), 'is false': (a) => !truthy(a),
  'matches': (a, b) => {
    try {
      return new RegExp(String(b ?? '')).test(String(a ?? ''));
    } catch {
      return false;
    }
  },
};

function parseCondition(raw: unknown): ConditionGroup | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!value || typeof value !== 'object' || Object.keys(value).length === 0) return null;
  if (Array.isArray((value as ConditionGroup).operands) && (value as ConditionGroup).operands!.length === 0) return null;
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
  spec: {
    label: 'Condition', category: 'logic', icon: 'branch', rfType: 'conditionNode',
    description: 'Route the flow down the first branch whose condition matches; Else catches the rest.',
    fields: [{ key: 'conditions', label: 'Branches', type: 'conditions' }, f.bool('allowMultipleConditionExecution', 'Run every matching branch', { advanced: true })],
    outputs: [{ path: 'condition', type: 'string', description: 'Label of the branch taken' }],
    defaults: () => ({ nodeName: 'Condition', conditions: [
      { label: 'Condition 1', value: 'condition-1', condition: '{"operator":null,"operands":[{"name":"","operator":"==","value":""}]}' },
      { label: 'Else', value: 'else', condition: '{}' },
    ], allowMultipleConditionExecution: false }),
  },
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
    const multiple = bool(ctx.values['allowMultipleConditionExecution']);
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

const CODE_LIMIT = 100_000;
const FORBIDDEN_CODE = /\brequire\s*\(|\beval\s*\(|\bFunction\s*\(|child_process|\bimport\s*\(|\bprocess\s*\./;
const codeHandler: NodeHandler = {
  type: 'codeNode',
  kind: 'action',
  spec: {
    label: 'Code', category: 'data', icon: 'code',
    description: 'Run JavaScript or TypeScript. Read upstream values with {{node.output.x}}; assign the result to `output` or return it.',
    fields: [{ key: 'code', label: 'JavaScript', type: 'code', required: true }],
    outputs: [{ path: '<field>', type: 'any', description: 'Whatever the code assigns to output' }],
    defaults: () => ({ nodeName: 'Code', code: '// Upstream values: {{triggerNode_1.output.question}}\noutput = { length: String({{triggerNode_1.output.question}} ?? "").length };' }),
  },
  validate(node) {
    const code = node.values['code'];
    if (typeof code !== 'string' || code.trim() === '') return [{ severity: 'error', code: 'CODE_MISSING', message: 'Code node has no code', nodeId: node.id }];
    const out: Diagnostic[] = [];
    if (code.length > CODE_LIMIT) out.push({ severity: 'error', code: 'CODE_TOO_LARGE', message: `Code is ${code.length} characters; the limit is ${CODE_LIMIT}`, nodeId: node.id });
    if (FORBIDDEN_CODE.test(code)) out.push({ severity: 'error', code: 'CODE_FORBIDDEN', message: 'Code uses require/eval/Function/dynamic import/process, which are blocked', nodeId: node.id });
    try {
      new vm.Script(`(async () => {\n${eraseTypes(code).replace(TEMPLATE_IN_CODE, 'null')}\n})`);
    } catch (e) {
      out.push({ severity: 'error', code: 'CODE_SYNTAX', message: (e as Error).message, nodeId: node.id });
    }
    return out;
  },
  async run(ctx) {
    const code = resolveCode(eraseTypes(String(ctx.values['code'] ?? '')), ctx.scope, opts(ctx));
    try {
      return { output: await runCodeInWorker(code, `${ctx.nodeId}.js`, ctx.services.codeTimeoutMs, ctx.signal, ctx.services.fetch) };
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      throw new EngineError('CODE_ERROR', `Code node failed: ${(e as Error)?.message ?? String(e)}`, { cause: e });
    }
  },
};

/* ---------------- API ---------------- */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const methodOf = (node: FlowNode) => String(node.values['method'] ?? 'GET').toUpperCase();

export async function readResponseBody(res: Response, convertXml: boolean): Promise<unknown> {
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json') && text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (convertXml && (type.includes('xml') || /^\s*<\?xml|^\s*<[a-z]/i.test(text))) return xmlToJson(text);
  return text;
}

const apiHandler: NodeHandler = {
  type: 'apiNode',
  kind: 'action',
  spec: {
    label: 'API', category: 'app', icon: 'http',
    description: 'Call any HTTP API. Unsafe methods send a stable Idempotency-Key and are not retried unless marked idempotent.',
    fields: [
      f.select('method', 'Method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      f.text('url', 'URL', { required: true, placeholder: 'https://api.example.com/items/{{triggerNode_1.output.id}}' }),
      f.json('headers', 'Headers'),
      f.json('body', 'Body', { showIf: { key: 'method', equals: ['POST', 'PUT', 'PATCH', 'DELETE'] } }),
      f.text('retries', 'Retries', { advanced: true }), f.text('retry_delay', 'Retry delay (s)', { advanced: true }),
      f.bool('idempotent', 'Safe to retry (idempotent)', { advanced: true }),
      f.bool('convertXmlResponseToJson', 'Convert XML responses to JSON', { advanced: true }),
    ],
    outputs: [{ path: '<field>', type: 'any', description: 'The response body (parsed JSON when possible)' }],
    defaults: () => ({ nodeName: 'API', method: 'GET', url: '', headers: '{}', body: '', retries: '0', retry_delay: '0' }),
  },
  sideEffect: (node) => !SAFE_METHODS.has(methodOf(node)),
  idempotent: (node) => SAFE_METHODS.has(methodOf(node)) || bool(node.values['idempotent']),
  validate(node) {
    const out = [...jsonDiagnostic(node, 'headers'), ...jsonDiagnostic(node, 'body')];
    if (typeof node.values['url'] !== 'string' || node.values['url'] === '') out.push({ severity: 'error', code: 'API_NO_URL', message: 'API node has no url', nodeId: node.id });
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(methodOf(node))) out.push({ severity: 'error', code: 'API_METHOD', message: `Unsupported method ${methodOf(node)}`, nodeId: node.id });
    return out;
  },
  async run(ctx) {
    const method = methodOf(ctx.node);
    const url = String(resolveValue(ctx.values['url'], ctx.scope, opts(ctx)));
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new EngineError('BAD_PAYLOAD', `API URL is not valid: ${url.slice(0, 200)}`);
    }
    const rawHeaders = ctx.values['headers'];
    const resolvedHeaders = rawHeaders ? resolveJsonTemplate(rawHeaders, ctx.scope, opts(ctx)) : {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((resolvedHeaders && typeof resolvedHeaders === 'object' ? resolvedHeaders : {}) as Record<string, unknown>)) headers[k] = str(v);
    const rawBody = ctx.values['body'];
    let body: string | undefined;
    if (rawBody !== undefined && rawBody !== '' && !SAFE_METHODS.has(method)) {
      const trimmed = typeof rawBody === 'string' ? rawBody.trim() : '';
      if (typeof rawBody === 'object' || trimmed.startsWith('{') || trimmed.startsWith('[')) {
        body = JSON.stringify(resolveJsonTemplate(rawBody, ctx.scope, opts(ctx)));
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      } else body = String(resolveValue(rawBody, ctx.scope, opts(ctx)));
    }
    if (!SAFE_METHODS.has(method) && !Object.keys(headers).some((h) => h.toLowerCase() === 'idempotency-key')) headers['Idempotency-Key'] = ctx.idempotencyKey;
    let res: Response;
    try {
      res = await ctx.services.fetch(parsedUrl.href, { method, headers, ...(body !== undefined ? { body } : {}), signal: ctx.signal });
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      // Already classified, such as an address the egress guard refused: not a network failure to retry.
      if (e instanceof EngineError) throw e;
      throw new EngineError('NETWORK', `Request to ${parsedUrl.host} failed: ${(e as Error).message}`, { retryable: true, cause: e });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = res.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_HTTP';
      throw new EngineError(code, `${method} ${parsedUrl.host} returned ${res.status}`, {
        retryable: res.status === 429 || res.status >= 500 || res.status === 408,
        details: { status: res.status, body: text.slice(0, 500) },
      });
    }
    return { output: await readResponseBody(res, bool(ctx.values['convertXmlResponseToJson'])) };
  },
};

/* ---------------- variables ---------------- */

function coerce(value: unknown, type: unknown): unknown {
  switch (type) {
    case 'number': return typeof value === 'number' ? value : Number(value);
    case 'boolean': return value === true || value === 'true';
    case 'object':
    case 'array':
    case 'json':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    case 'string': return typeof value === 'string' ? value : JSON.stringify(value);
    default: return value;
  }
}

const variablesHandler: NodeHandler = {
  type: 'variablesNode',
  kind: 'action',
  spec: {
    label: 'Variables', category: 'data', icon: 'variables', description: 'Name and type values for later nodes.',
    fields: [{ key: 'mapping', label: 'Variables', type: 'mapping' }],
    outputs: [{ path: '<name>', type: 'any' }],
    defaults: () => ({ nodeName: 'Variables', mapping: '{\n  "name": { "type": "string", "value": "" }\n}' }),
  },
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

/* ---------------- loops, batches, branches ---------------- */

async function iterateValues(ctx: NodeContext): Promise<unknown[]> {
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
    return items;
  }
  const list = jsonish(resolveValue(ctx.values['iteratorValue'], ctx.scope, opts(ctx)));
  if (!Array.isArray(list)) throw new EngineError('BAD_PAYLOAD', `Loop iteratorValue must resolve to an array, got ${list === null ? 'null' : typeof list}`);
  return list;
}

const loopFields = [
  f.select('iterateOver', 'Iterate over', [['list', 'A list'], ['range', 'A number range']]),
  f.text('iteratorValue', 'List', { showIf: { key: 'iterateOver', equals: ['list'] }, placeholder: '{{codeNode_1.output.items}}' }),
  f.text('initialValue', 'Start', { showIf: { key: 'iterateOver', equals: ['range'] } }),
  f.text('endValue', 'End (exclusive)', { showIf: { key: 'iterateOver', equals: ['range'] } }),
  f.text('increment', 'Step', { showIf: { key: 'iterateOver', equals: ['range'] } }),
];

function loopStart(type: string, label: string, batch: boolean): NodeHandler {
  return {
    type,
    kind: 'loopStart',
    spec: {
      label, category: 'logic', icon: batch ? 'batch' : 'loop', rfType: type,
      description: batch ? 'Process list items in parallel batches; results are collected by Batch End.' : 'Run the nodes between Loop and Loop End once per item.',
      fields: batch ? [...loopFields, f.num('concurrencyLimit', 'Parallel items')] : [...loopFields, f.num('wait', 'Wait between iterations (s)', { advanced: true })],
      outputs: [{ path: 'currentValue', type: 'any' }, { path: 'index', type: 'number' }],
      defaults: () => ({ nodeName: label, iterateOver: 'list', iteratorValue: '', connectedTo: '', ...(batch ? { concurrencyLimit: 4 } : { wait: 0 }) }),
    },
    validate(node) {
      const mode = node.values['iterateOver'] ?? 'list';
      if (mode !== 'list' && mode !== 'range') return [{ severity: 'error', code: 'LOOP_MODE', message: `iterateOver must be "list" or "range", got ${String(mode)}`, nodeId: node.id }];
      return [];
    },
    async iterate(ctx) {
      const items = await iterateValues(ctx);
      const waitMs = batch ? 0 : Math.min(Math.max(num(ctx.values['wait'], 0), 0), 30) * 1000;
      return { items, waitMs, concurrency: batch ? Math.min(Math.max(Math.trunc(num(ctx.values['concurrencyLimit'], 4)), 1), 32) : 1 };
    },
    async run() {
      throw new EngineError('INTERNAL', `${type} is driven by the executor`);
    },
  };
}

function loopEnd(type: string, label: string, outputs: NodeSpec['outputs']): NodeHandler {
  return {
    type,
    kind: 'loopEnd',
    spec: { label, category: 'logic', icon: 'loop', rfType: type, hidden: true, description: 'Collects the results of every iteration.', fields: [], outputs, defaults: () => ({ nodeName: label, connectedTo: '' }) },
    async run() {
      throw new EngineError('INTERNAL', `${type} is driven by the executor`);
    },
  };
}

const branchHandler: NodeHandler = {
  type: 'branchNode',
  kind: 'action',
  spec: {
    label: 'Parallel Branches', category: 'logic', icon: 'parallel', rfType: 'branchNode',
    description: 'Fan out: every connected branch runs at the same time.',
    fields: [{ key: 'branches', label: 'Branches', type: 'branches' }], outputs: [],
    defaults: () => ({ nodeName: 'Branch', branches: [{ label: 'Branch 1', value: 'branch-1' }, { label: 'Branch 2', value: 'branch-2' }] }),
  },
  async run() {
    return { output: {} };
  },
};

const waitHandler: NodeHandler = {
  type: 'waitNode',
  kind: 'action',
  spec: {
    label: 'Wait', category: 'logic', icon: 'clock', description: 'Pause before continuing (up to 10 minutes).',
    fields: [f.num('seconds', 'Seconds', { required: true })], outputs: [{ path: 'success', type: 'boolean' }],
    defaults: () => ({ nodeName: 'Wait', seconds: 1 }),
  },
  async run(ctx) {
    const seconds = Math.min(Math.max(num(val(ctx, 'seconds', 0), 0), 0), 600);
    await sleep(seconds * 1000, undefined, { signal: ctx.signal });
    return { output: { success: true, waitedSeconds: seconds } };
  },
};

const endHandler: NodeHandler = {
  type: 'endNode',
  kind: 'action',
  spec: { label: 'End', category: 'logic', icon: 'stop', description: 'Ends this path of the flow.', fields: [], outputs: [], defaults: () => ({ nodeName: 'End' }) },
  async run() {
    return { output: {} };
  },
};

const flowHandler: NodeHandler = {
  type: 'flowNode',
  kind: 'action',
  spec: {
    label: 'Run Flow', category: 'logic', icon: 'flow', description: 'Call another deployed flow and use its response.',
    fields: [{ key: 'flowId', label: 'Flow', type: 'flow', required: true }, f.json('requestInput', 'Payload')],
    outputs: [{ path: 'flowOutput', type: 'any' }],
    defaults: () => ({ nodeName: 'Run Flow', flowId: '', requestInput: '{}' }),
  },
  validate: (node) => [...required(node, 'flowId'), ...jsonDiagnostic(node, 'requestInput')],
  async run(ctx) {
    if (!ctx.services.invokeFlow) throw new EngineError('INTERNAL', 'Flow calls are not available in this runtime');
    const flowId = str(val(ctx, 'flowId'));
    if (flowId === ctx.flowId) throw new EngineError('BAD_PAYLOAD', 'A flow cannot call itself');
    const payload = jsonField(ctx, 'requestInput', {});
    const res = await ctx.services.invokeFlow(flowId, payload, ctx.signal);
    if (res.status !== 'success') throw new EngineError('UPSTREAM_HTTP', `Flow ${flowId} ${res.status}: ${res.error?.message ?? 'no response'}`);
    return { output: { flowOutput: res.output } };
  },
};

export const coreHandlers: NodeHandler[] = [
  ...triggers,
  graphqlResponse, chatResponse, searchResponse, askResponse,
  conditionHandler, codeHandler, apiHandler, variablesHandler,
  loopStart('forLoopNode', 'Loop', false),
  loopEnd('forLoopEndNode', 'Loop End', [{ path: 'loopOutput', type: 'array', description: 'One entry per iteration: { <nodeId>: { output } }' }]),
  loopStart('batchNode', 'Batch', true),
  loopEnd('batchEndNode', 'Batch End', [{ path: 'batchOutput', type: 'array' }]),
  branchHandler, waitHandler, endHandler, flowHandler,
];
