import { EngineError, toEngineError } from '../errors.ts';
import type { Diagnostic, FlowNode } from '../flow/schema.ts';
import { resolveJsonTemplate, resolveValue } from '../flow/template.ts';
import { chat, type ChatResult } from '../llm/router.ts';
import type { LLMMessage, ToolSpec } from '../llm/types.ts';
import { parseFilter, type MetadataFilter } from '../vector/filters.ts';
import { validateJsonSchema } from './jsonschema.ts';
import { eraseTypes, runCodeInWorker } from './code-worker-runner.ts';
import { McpClient } from '../integrations/mcp.ts';
import { f, jsonish, lenient, loadFile, metaOutputs, modelConfigs, modelLabel, num, opts, str, val } from './common.ts';
import { retrieve, toSearchResult } from './retrieval.ts';
import type { AgentDecision, AgentTurn, FieldSpec, NodeContext, NodeHandler, NodeOutput, NodeSpec, Usage } from './types.ts';

/* ---------------- messages ---------------- */

interface PromptEntry { role?: unknown; content?: unknown }

function asMessages(raw: unknown): LLMMessage[] {
  const value = jsonish(raw);
  if (!Array.isArray(value)) return [];
  return value.flatMap((m): LLMMessage[] => {
    if (!m || typeof m !== 'object') return [];
    const o = m as Record<string, unknown>;
    const content = str(o['content'] ?? o['message'] ?? o['text']);
    if (!content) return [];
    const role = String(o['role'] ?? 'user').toLowerCase();
    return [{ role: role === 'assistant' || role === 'bot' || role === 'ai' ? 'assistant' : role === 'system' ? 'system' : 'user', content }];
  });
}

function asMemoryLines(raw: unknown): string[] {
  const value = jsonish(raw);
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((m) => (m && typeof m === 'object' ? str((m as Record<string, unknown>)['memory'] ?? (m as Record<string, unknown>)['content'] ?? m) : str(m))).filter(Boolean);
}

/** System prompts, then memories, then chat history, then the remaining prompts in order. */
export function buildMessages(ctx: NodeContext, extraUser?: string): LLMMessage[] {
  const prompts: PromptEntry[] = Array.isArray(ctx.values['prompts']) ? (ctx.values['prompts'] as PromptEntry[]) : [];
  const resolved: LLMMessage[] = prompts.map((p) => ({
    role: p.role === 'system' || p.role === 'assistant' ? p.role : 'user',
    content: str(resolveValue(p.content ?? '', ctx.scope, opts(ctx))),
  }));
  if (resolved.length === 0) {
    const system = val(ctx, 'systemPrompt');
    const template = val(ctx, 'promptTemplate');
    if (system) resolved.push({ role: 'system', content: str(system) });
    if (template) resolved.push({ role: 'user', content: str(template) });
  }
  const system = resolved.filter((m) => m.role === 'system');
  const rest = resolved.filter((m) => m.role !== 'system');
  const memories = asMemoryLines(resolveValue(ctx.values['memories'] ?? '', ctx.scope, lenient(ctx)));
  if (memories.length) system.push({ role: 'system', content: `Relevant memories:\n${memories.map((m) => `- ${m}`).join('\n')}` });
  const history = asMessages(resolveValue(ctx.values['messages'] ?? '', ctx.scope, lenient(ctx)));
  const out = [...system, ...history, ...rest];
  if (extraUser) out.push({ role: 'user', content: extraUser });
  if (!out.some((m) => m.role !== 'system')) throw new EngineError('BAD_PAYLOAD', 'The prompt has no user message');
  return out;
}

async function attachImages(ctx: NodeContext, messages: LLMMessage[]): Promise<void> {
  const raw = jsonish(val(ctx, 'attachments', undefined, false));
  const urls = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((u) => (u && typeof u === 'object' ? str((u as Record<string, unknown>)['url'] ?? (u as Record<string, unknown>)['fileUrl']) : str(u))).filter(Boolean);
  if (!urls.length) return;
  const images: string[] = [];
  for (const url of urls.slice(0, 8)) {
    if (url.startsWith('data:image/')) images.push(url);
    else {
      const file = await loadFile(url, ctx);
      images.push(`data:${file.mime.startsWith('image/') ? file.mime : 'image/png'};base64,${Buffer.from(file.bytes).toString('base64')}`);
    }
  }
  const lastUser = messages.findLast((m) => m.role === 'user');
  if (lastUser) lastUser.images = images;
}

/* ---------------- model calls ---------------- */

export interface GenerateOptions {
  messages: LLMMessage[];
  jsonSchema?: Record<string, unknown>;
  tools?: ToolSpec[];
  field?: string;
  stream?: boolean;
}

/** Calls the node's model; extra configs (configB…) act as fallbacks when the first one fails. */
export async function generate(ctx: NodeContext, o: GenerateOptions): Promise<ChatResult & { fallbackUsed: boolean }> {
  const configs = modelConfigs(ctx.values[o.field ?? 'generativeModelName']);
  if (configs.length === 0) configs.push({ params: {} });
  let lastError: unknown;
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i]!;
    const params = cfg.params;
    const maxTokens = num(ctx.values['max_tokens'] ?? ctx.values['maxTokens'] ?? params['max_tokens'] ?? params['maxTokens'], NaN);
    const temperature = num(ctx.values['temperature'] ?? params['temperature'], NaN);
    const topP = num(params['top_p'] ?? params['topP'], NaN);
    const stop = Array.isArray(params['stop']) ? (params['stop'] as unknown[]).map(String) : undefined;
    try {
      const res = await chat(ctx.services.llm, {
        ref: cfg, messages: o.messages, signal: ctx.signal,
        ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        ...(Number.isFinite(topP) ? { topP } : {}),
        ...(stop?.length ? { stop } : {}),
        ...(o.jsonSchema ? { jsonSchema: o.jsonSchema } : {}),
        ...(o.tools?.length ? { tools: o.tools } : {}),
        ...(o.stream ? { onToken: (delta: string) => ctx.emit({ type: 'node.token', data: delta }) } : {}),
      });
      return { ...res, fallbackUsed: i > 0 };
    } catch (e) {
      lastError = e;
      const err = toEngineError(e);
      if (ctx.signal.aborted || err.code === 'CANCELLED' || i === configs.length - 1) throw e;
      ctx.emit({ type: 'node.progress', data: { fallback: i + 1, error: err.message } });
    }
  }
  throw lastError;
}

function meta(res: ChatResult): Record<string, unknown> {
  return {
    prompt_tokens: res.inputTokens, completion_tokens: res.outputTokens, total_tokens: res.inputTokens + res.outputTokens,
    model_name: res.model, model_provider: res.connectionId, ...(res.mapped ? { mapped_to_local: true } : {}),
  };
}

const usageOf = (res: ChatResult): Partial<Usage> => ({ llmCalls: 1, inputTokens: res.inputTokens, outputTokens: res.outputTokens });
function addUsage(a: Partial<Usage>, b: Partial<Usage>): Partial<Usage> {
  return { llmCalls: (a.llmCalls ?? 0) + (b.llmCalls ?? 0), inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0), outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0) };
}

function promptValidate(node: FlowNode): Diagnostic[] {
  const prompts = node.values['prompts'];
  const legacy = node.values['promptTemplate'] || node.values['systemPrompt'];
  if ((!Array.isArray(prompts) || prompts.length === 0) && !legacy) return [{ severity: 'error', code: 'LLM_NO_PROMPT', message: 'AI node has no prompts', nodeId: node.id }];
  return [];
}

/* ---------------- tools ---------------- */

interface ToolDefinition {
  type: 'flow' | 'vectorSearch' | 'http' | 'code' | 'mcp';
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  flowId?: string;
  vectorDB?: string;
  limit?: number;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  code?: string;
  /** mcp: credential holding the server URL; optional subset of tool names. */
  credential?: string;
  tools?: string[];
}

/** A callable tool for the model: its schema and how to run it. */
export interface ToolBinding {
  spec: ToolSpec;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function toolDefinitions(node: FlowNode): { tools: ToolDefinition[]; ignored: string[] } {
  const raw = jsonish(node.values['tools']);
  const list = Array.isArray(raw) ? raw : [];
  const tools: ToolDefinition[] = [];
  const ignored: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || !['flow', 'vectorSearch', 'http', 'code', 'mcp'].includes(String((item as ToolDefinition).type))) {
      ignored.push(typeof item === 'string' ? item : JSON.stringify(item).slice(0, 60));
      continue;
    }
    const t = item as ToolDefinition;
    const name = t.name || (t.type === 'flow' ? `run_${t.flowId}` : t.type === 'vectorSearch' ? `search_${t.vectorDB}` : t.type === 'mcp' ? `mcp_${t.credential}` : t.type);
    tools.push({ ...t, name: name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64), description: t.description || defaultToolDescription(t) });
  }
  return { tools, ignored };
}

function defaultToolDescription(t: ToolDefinition): string {
  switch (t.type) {
    case 'flow': return `Runs the "${t.flowId}" flow and returns its response.`;
    case 'vectorSearch': return `Searches the "${t.vectorDB}" knowledge base and returns the most relevant passages.`;
    case 'http': return `Calls ${t.method ?? 'GET'} ${t.url}.`;
    case 'mcp': return `Tools from the ${t.credential} MCP server.`;
    default: return 'Runs a JavaScript function.';
  }
}

function toolSpec(t: ToolDefinition): ToolSpec {
  const parameters = t.parameters ?? (t.type === 'vectorSearch'
    ? { type: 'object', properties: { query: { type: 'string', description: 'What to search for' } }, required: ['query'] }
    : { type: 'object', properties: {}, additionalProperties: true });
  return { name: t.name, description: t.description, parameters };
}

async function runTool(ctx: NodeContext, t: ToolDefinition, args: Record<string, unknown>): Promise<unknown> {
  switch (t.type) {
    case 'flow': {
      if (!ctx.services.invokeFlow) throw new EngineError('INTERNAL', 'Flow tools are not available in this runtime');
      if (t.flowId === ctx.flowId) throw new EngineError('BAD_PAYLOAD', 'A flow cannot call itself as a tool');
      const res = await ctx.services.invokeFlow(String(t.flowId), args, ctx.signal);
      if (res.status !== 'success') throw new EngineError('UPSTREAM_HTTP', `Flow ${t.flowId} ${res.status}: ${res.error?.message ?? ''}`);
      return res.output;
    }
    case 'vectorSearch': {
      const { hits } = await retrieve(ctx, { collection: String(t.vectorDB), query: str(args['query']), mode: 'hybrid', limit: Math.min(Math.max(t.limit ?? 4, 1), 20) });
      return hits.map((h) => ({ content: h.text, source: h.metadata['source'] ?? h.metadata['title'] ?? h.id, score: h.score }));
    }
    case 'http': {
      const method = (t.method ?? 'GET').toUpperCase();
      const url = new URL(String(t.url));
      if (method === 'GET') for (const [k, v] of Object.entries(args)) url.searchParams.set(k, str(v));
      const res = await ctx.services.fetch(url.href, {
        method, signal: ctx.signal, headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(t.headers ?? {}) },
        ...(method !== 'GET' ? { body: JSON.stringify(args) } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new EngineError('UPSTREAM_HTTP', `${method} ${url.host} returned ${res.status}`);
      try {
        return JSON.parse(text);
      } catch {
        return text.slice(0, 20_000);
      }
    }
    case 'code':
      return runCodeInWorker(`const args = ${JSON.stringify(args)};\n${eraseTypes(t.code ?? '')}`, `${ctx.nodeId}-${t.name}.js`, ctx.services.codeTimeoutMs, ctx.signal);
    case 'mcp':
      throw new EngineError('INTERNAL', 'MCP tools are expanded before the call');
  }
}

/** MCP tools exposed by one server, optionally filtered to `only`. */
export async function mcpBindings(ctx: NodeContext, credentialRef: string | undefined, only: string[] = []): Promise<ToolBinding[]> {
  const cred = ctx.services.credentials?.resolve(credentialRef, 'mcp');
  if (!cred?.['url']) throw new EngineError('BAD_PAYLOAD', `MCP server credential ${credentialRef ?? '(default)'} not found; add one under Integrations → MCP`);
  let headers: Record<string, string> = {};
  if (cred['headers']) {
    try {
      headers = JSON.parse(cred['headers']) as Record<string, string>;
    } catch {
      throw new EngineError('BAD_PAYLOAD', 'MCP credential headers must be a JSON object');
    }
  }
  if (cred['token']) headers['authorization'] ??= `Bearer ${cred['token']}`;
  const client = new McpClient(cred['url'], { headers, fetch: ctx.services.fetch });
  const tools = await client.listTools(ctx.signal);
  return tools
    .filter((t) => only.length === 0 || only.includes(t.name))
    .map((t) => ({
      spec: { name: t.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64), description: t.description ?? t.name, parameters: t.inputSchema ?? { type: 'object', properties: {} } },
      run: async (args) => {
        const r = await client.callTool(t.name, args, ctx.signal);
        if (r.isError) throw new EngineError('UPSTREAM_HTTP', r.text || `MCP tool ${t.name} failed`);
        return r.structured ?? r.text;
      },
    }));
}

/** Expands a node's `tools` value into callable bindings. */
export async function toolBindings(ctx: NodeContext): Promise<ToolBinding[]> {
  const { tools } = toolDefinitions(ctx.node);
  const out: ToolBinding[] = [];
  for (const t of tools) {
    if (t.type === 'mcp') out.push(...await mcpBindings(ctx, t.credential, t.tools ?? []));
    else out.push({ spec: toolSpec(t), run: (args) => runTool(ctx, t, args) });
  }
  return out;
}

/* ---------------- LLM node ---------------- */

const promptFields: FieldSpec[] = [
  f.model(),
  { key: 'prompts', label: 'Prompts', type: 'prompts', required: true },
  { key: 'messages', label: 'Chat history', type: 'messages', help: 'Optional conversation history, e.g. {{triggerNode_1.output.chatHistory}}', advanced: true },
  f.text('memories', 'Memories', { help: 'Optional memories, e.g. {{memoryRetrieveNode_1.output.memories}}', advanced: true }),
];

const defaultPrompts = () => [
  { id: 'system', role: 'system', content: 'You are a helpful assistant. Answer concisely.' },
  { id: 'user', role: 'user', content: '{{triggerNode_1.output.question}}' },
];

export async function runChatNode(ctx: NodeContext, outputKey: string, extraTools: ToolBinding[] = []): Promise<NodeOutput> {
  const messages = buildMessages(ctx);
  await attachImages(ctx, messages);
  const tools = [...await toolBindings(ctx), ...extraTools];
  if (!tools.length) {
    const res = await generate(ctx, { messages, stream: true });
    return { output: { [outputKey]: res.text, _meta: meta(res) }, usage: usageOf(res), models: [modelLabel(res.connectionId, res.model)] };
  }
  // Tool loop: the model calls tools until it answers in text or the round limit is hit.
  const specs = tools.map((t) => t.spec);
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const rounds = Math.min(Math.max(Math.trunc(num(ctx.values['maxToolRounds'], 5)), 1), 20);
  const calls: { name: string; arguments: Record<string, unknown>; result?: unknown; error?: string }[] = [];
  let usage: Partial<Usage> = {};
  const models = new Set<string>();
  let last: ChatResult | undefined;
  for (let round = 0; round <= rounds; round++) {
    const res = await generate(ctx, { messages, ...(round < rounds ? { tools: specs } : {}) });
    last = res;
    usage = addUsage(usage, usageOf(res));
    models.add(modelLabel(res.connectionId, res.model));
    if (!res.toolCalls?.length) break;
    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      const tool = byName.get(call.name);
      let content: string;
      try {
        if (!tool) throw new EngineError('BAD_PAYLOAD', `Unknown tool ${call.name}`);
        const result = await tool.run(call.arguments);
        calls.push({ name: call.name, arguments: call.arguments, result });
        content = typeof result === 'string' ? result : JSON.stringify(result);
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        const message = toEngineError(e).message;
        calls.push({ name: call.name, arguments: call.arguments, error: message });
        content = `Error: ${message}`;
      }
      ctx.emit({ type: 'node.progress', data: { tool: call.name } });
      messages.push({ role: 'tool', content: content.slice(0, 30_000), toolCallId: call.id, name: call.name });
    }
  }
  return { output: { [outputKey]: last?.text ?? '', toolCalls: calls, _meta: last ? meta(last) : {} }, usage, models: [...models] };
}

function chatNodeSpec(label: string, description: string, extra: FieldSpec[] = [], outputKey = 'generatedResponse'): NodeSpec {
  return {
    label, category: 'ai', icon: 'sparkles', description,
    fields: [...promptFields, ...extra, { key: 'tools', label: 'Tools', type: 'tools', advanced: true, help: 'Let the model call other flows, search knowledge bases, call HTTP APIs or run code.' }, f.num('max_tokens', 'Max output tokens', { advanced: true }), f.num('temperature', 'Temperature', { advanced: true })],
    outputs: [{ path: outputKey, type: 'string' }, { path: 'toolCalls', type: 'array' }, ...metaOutputs],
    defaults: () => ({ nodeName: label, prompts: defaultPrompts(), memories: '[]', messages: '[]', tools: [] }),
  };
}

function toolValidate(node: FlowNode): Diagnostic[] {
  const { tools, ignored } = toolDefinitions(node);
  const out: Diagnostic[] = ignored.length
    ? [{ severity: 'warning', code: 'TOOLS_IGNORED', message: `${ignored.length} imported tool reference(s) have no local definition and are ignored`, nodeId: node.id }]
    : [];
  for (const t of tools) {
    if (!TOOL_NAME.test(t.name)) out.push({ severity: 'error', code: 'TOOL_INVALID', message: `Tool name "${t.name}" must be a simple identifier`, nodeId: node.id });
    if (t.type === 'flow' && !t.flowId) out.push({ severity: 'error', code: 'TOOL_INVALID', message: `Tool ${t.name} needs a flowId`, nodeId: node.id });
    if (t.type === 'vectorSearch' && !t.vectorDB) out.push({ severity: 'error', code: 'TOOL_INVALID', message: `Tool ${t.name} needs a vectorDB`, nodeId: node.id });
    if (t.type === 'http' && !t.url) out.push({ severity: 'error', code: 'TOOL_INVALID', message: `Tool ${t.name} needs a url`, nodeId: node.id });
    if (t.type === 'mcp' && !t.credential) out.push({ severity: 'error', code: 'TOOL_INVALID', message: `Tool ${t.name} needs an MCP server credential`, nodeId: node.id });
  }
  return out;
}

const llmHandler: NodeHandler = {
  type: 'LLMNode',
  kind: 'action',
  spec: chatNodeSpec('Generate Text', 'Generate text with a local model. Supports chat history, memories, image attachments and tools.'),
  validate: (node) => [...promptValidate(node), ...toolValidate(node)],
  run: (ctx) => runChatNode(ctx, 'generatedResponse'),
};

const multiModalHandler: NodeHandler = {
  type: 'multiModalLLMNode',
  kind: 'action',
  spec: chatNodeSpec('Generate Text (Vision)', 'Send images with the prompt to a local vision model (e.g. llava, qwen2.5-vl, gemma3).', [f.text('attachments', 'Image URLs', { help: 'One URL, data URL or uploaded file, or a list of them' })]),
  validate: (node) => [...promptValidate(node), ...toolValidate(node)],
  run: (ctx) => runChatNode(ctx, 'generatedResponse'),
};

/* ---------------- structured output ---------------- */

function parseSchema(raw: unknown): Record<string, unknown> {
  const schema = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!schema || typeof schema !== 'object') throw new EngineError('BAD_PAYLOAD', 'Structured-output node needs a JSON schema');
  return schema as Record<string, unknown>;
}

/** Local models sometimes wrap JSON in prose or code fences; take the outermost object. */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {
        /* fall through */
      }
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('no JSON object found');
  }
}

const instructorHandler: NodeHandler = {
  type: 'InstructorLLMNode',
  kind: 'action',
  spec: {
    label: 'Generate JSON', category: 'ai', icon: 'json',
    description: 'Generate structured data that matches a JSON schema; output fields are available as {{node.output.field}}.',
    fields: [...promptFields, { key: 'schema', label: 'Output schema', type: 'schema', required: true }, f.num('max_tokens', 'Max output tokens', { advanced: true })],
    outputs: [{ path: '<field>', type: 'any', description: 'Each schema property' }, ...metaOutputs],
    defaults: () => ({ nodeName: 'Generate JSON', prompts: defaultPrompts(), schema: '{\n  "type": "object",\n  "properties": {\n    "answer": { "type": "string" }\n  },\n  "required": ["answer"]\n}', memories: '[]', messages: '[]' }),
  },
  validate(node) {
    const out = promptValidate(node);
    try {
      parseSchema(node.values['schema']);
    } catch (e) {
      out.push({ severity: 'error', code: 'SCHEMA_INVALID', message: `schema is not valid JSON: ${(e as Error).message}`, nodeId: node.id });
    }
    return out;
  },
  async run(ctx) {
    const schema = parseSchema(ctx.values['schema']);
    const messages = buildMessages(ctx);
    await attachImages(ctx, messages);
    const res = await generate(ctx, { messages, jsonSchema: schema });
    const usage = usageOf(res);
    let parsed: unknown;
    try {
      parsed = extractJson(res.text);
    } catch {
      throw new EngineError('OUTPUT_SCHEMA', 'Model output is not valid JSON', { retryable: true, details: { usage } });
    }
    const errors = validateJsonSchema(parsed, schema);
    if (errors.length) throw new EngineError('OUTPUT_SCHEMA', `Model output does not match the schema: ${errors.slice(0, 5).join('; ')}`, { retryable: true, details: { errors, usage } });
    const output = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as object), _meta: meta(res) } : parsed;
    return { output, usage, models: [modelLabel(res.connectionId, res.model)] };
  },
};

/* ---------------- classifier ---------------- */

interface ClassOption { label?: string; value?: string; description?: string }
const classOptions = (node: FlowNode): ClassOption[] => (Array.isArray(node.values['classifier']) ? (node.values['classifier'] as ClassOption[]) : []);

const classifierHandler: NodeHandler = {
  type: 'agentClassifierNode',
  kind: 'condition',
  spec: {
    label: 'Classifier', category: 'ai', icon: 'classify', rfType: 'agentClassifierNode',
    description: 'Let a local model pick one of several categories and route the flow down that branch.',
    fields: [f.model(), { key: 'prompts', label: 'Instructions', type: 'prompts' }, { key: 'classifier', label: 'Categories', type: 'classifier', required: true }],
    outputs: [{ path: 'class', type: 'string' }, { path: 'condition', type: 'string' }],
    defaults: () => ({ nodeName: 'Classifier', prompts: [{ id: 'user', role: 'user', content: '{{triggerNode_1.output.question}}' }], classifier: [{ label: 'Question', value: 'question' }, { label: 'Other', value: 'other' }] }),
  },
  branchKeys: (node) => classOptions(node).map((c) => c.value ?? c.label).filter((v): v is string => typeof v === 'string'),
  validate(node) {
    const opts = classOptions(node);
    return opts.length < 2 || opts.some((o) => !o.label) ? [{ severity: 'error', code: 'CLASSIFIER_INVALID', message: 'Classifier needs at least two labelled categories', nodeId: node.id }] : [];
  },
  async run(ctx) {
    const options = classOptions(ctx.node);
    const labels = options.map((o) => o.label!);
    const instruction = `Classify the input into exactly one category: ${options.map((o) => `"${o.label}"${o.description ? ` (${o.description})` : ''}`).join(', ')}. Reply with JSON {"class": "<category>"}.`;
    const messages = [{ role: 'system' as const, content: instruction }, ...buildMessages(ctx)];
    const res = await generate(ctx, { messages, jsonSchema: { type: 'object', properties: { class: { type: 'string', enum: labels } }, required: ['class'] } });
    let chosen: string | undefined;
    try {
      const parsed = extractJson(res.text) as { class?: unknown };
      chosen = labels.find((l) => l.toLowerCase() === String(parsed.class ?? '').trim().toLowerCase());
    } catch {
      chosen = labels.find((l) => res.text.toLowerCase().includes(l.toLowerCase()));
    }
    if (!chosen) throw new EngineError('OUTPUT_SCHEMA', `Model did not choose one of: ${labels.join(', ')}`, { retryable: true, details: { usage: usageOf(res) } });
    const option = options.find((o) => o.label === chosen)!;
    return { output: { class: chosen, condition: chosen, _meta: meta(res) }, branches: [option.value ?? option.label!], usage: usageOf(res), models: [modelLabel(res.connectionId, res.model)] };
  },
};

/* ---------------- supervisor agent ---------------- */

interface SubAgent { name?: string; description?: string; schema?: unknown }
const subAgents = (node: FlowNode): SubAgent[] => (Array.isArray(node.values['agents']) ? (node.values['agents'] as SubAgent[]) : []);
const FINISH = 'FINISH';

function agentSchema(agent: SubAgent): Record<string, unknown> {
  const raw = jsonish(agent.schema);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (o['properties']) return o;
    return { type: 'object', properties: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? { type: ['string', 'number', 'boolean', 'array', 'object'].includes(v) ? v : 'string', description: v } : v])) };
  }
  return { type: 'object', properties: {} };
}

const agentHandler: NodeHandler = {
  type: 'agentNode',
  kind: 'agentStart',
  spec: {
    label: 'Supervisor Agent', category: 'ai', icon: 'agent', rfType: 'agentNode',
    description: 'A local model plans and delegates to sub-agent branches, loops on their results, and finishes with an answer.',
    fields: [f.model(), { key: 'prompts', label: 'Instructions', type: 'prompts' }, { key: 'agents', label: 'Sub-agents', type: 'agents', required: true },
      { key: 'messages', label: 'Chat history', type: 'messages', advanced: true }, f.num('maxIterations', 'Max turns'), f.text('stopWord', 'Stop word', { advanced: true })],
    outputs: [{ path: '<argument>', type: 'any', description: 'Arguments chosen for the current sub-agent' }, { path: 'agent', type: 'string' }],
    defaults: () => ({ nodeName: 'Supervisor', prompts: [{ id: 'system', role: 'system', content: 'You coordinate specialists to answer the request.' }, { id: 'user', role: 'user', content: '{{triggerNode_1.output.question}}' }], agents: [{ name: 'Researcher', description: 'Finds facts', schema: '{"query": "string"}' }], maxIterations: 5, connectedTo: '', messages: '[]', stopWord: '' }),
  },
  branchKeys: (node) => subAgents(node).map((a) => a.name).filter((n): n is string => typeof n === 'string' && n !== ''),
  validate(node) {
    const agents = subAgents(node);
    if (agents.length === 0 || agents.some((a) => !a.name)) return [{ severity: 'error', code: 'AGENTS_INVALID', message: 'Supervisor needs named sub-agents', nodeId: node.id }];
    return [];
  },
  async decide(ctx, history: AgentTurn[]): Promise<AgentDecision> {
    const agents = subAgents(ctx.node);
    const names = agents.map((a) => a.name!);
    const properties: Record<string, unknown> = {
      next: { type: 'string', enum: [...names, FINISH], description: 'The sub-agent to run next, or FINISH' },
      final_answer: { type: 'string', description: 'The final answer when next is FINISH' },
    };
    for (const a of agents) for (const [k, v] of Object.entries((agentSchema(a)['properties'] ?? {}) as Record<string, unknown>)) properties[k] ??= v;
    const catalog = agents.map((a) => `- ${a.name}: ${a.description ?? ''} Arguments: ${JSON.stringify(agentSchema(a)['properties'] ?? {})}`).join('\n');
    const turns = history.map((t, i) => `Turn ${i + 1}: ${t.agent} was given ${JSON.stringify(t.input)} and returned ${JSON.stringify(t.output).slice(0, 4000)}`).join('\n');
    const instruction = `You are a supervisor. Available sub-agents:\n${catalog}\nChoose the next sub-agent and its arguments, or choose ${FINISH} and write final_answer when the request is fully handled. Reply only with JSON.${turns ? `\n\nProgress so far:\n${turns}` : ''}`;
    const messages = [{ role: 'system' as const, content: instruction }, ...buildMessages(ctx)];
    const res = await generate(ctx, { messages, jsonSchema: { type: 'object', properties, required: ['next'] } });
    const usage = usageOf(res);
    let parsed: Record<string, unknown>;
    try {
      parsed = extractJson(res.text) as Record<string, unknown>;
    } catch {
      throw new EngineError('OUTPUT_SCHEMA', 'Supervisor reply is not valid JSON', { retryable: true, details: { usage } });
    }
    const next = String(parsed['next'] ?? '');
    const stopWord = str(ctx.values['stopWord']);
    if (next === FINISH || !names.includes(next) || (stopWord && res.text.includes(stopWord))) {
      return { done: true, finalResponse: parsed['final_answer'] ?? history.at(-1)?.output ?? res.text, usage };
    }
    const allowed = Object.keys((agentSchema(agents.find((a) => a.name === next)!)['properties'] ?? {}) as Record<string, unknown>);
    const input = Object.fromEntries(Object.entries(parsed).filter(([k]) => allowed.includes(k)));
    return { done: false, agent: next, input, usage };
  },
  async run() {
    throw new EngineError('INTERNAL', 'agentNode is driven by the executor');
  },
};

const agentEndHandler: NodeHandler = {
  type: 'agentLoopEndNode',
  kind: 'agentEnd',
  spec: {
    label: 'Agent Loop End', category: 'ai', icon: 'agent', rfType: 'agentLoopEndNode', hidden: true,
    description: 'Collects sub-agent results for the supervisor.', fields: [],
    outputs: [{ path: 'finalResponse', type: 'any' }, { path: 'history', type: 'array' }],
    defaults: () => ({ nodeName: 'Agent Loop End', connectedTo: '' }),
  },
  async run() {
    throw new EngineError('INTERNAL', 'agentLoopEndNode is driven by the executor');
  },
};

/* ---------------- RAG ---------------- */

const ragHandler: NodeHandler = {
  type: 'RAGNode',
  kind: 'action',
  spec: {
    label: 'RAG', category: 'rag', icon: 'rag',
    description: 'Retrieve the most relevant passages from a vector database and answer with a local model, citing references.',
    fields: [
      f.text('queryField', 'Query', { required: true, placeholder: '{{triggerNode_1.output.question}}' }),
      f.vectorDB(), f.embedding(), f.model(),
      { key: 'prompts', label: 'Instructions', type: 'prompts' },
      f.num('limit', 'Passages to retrieve'), f.text('certainty', 'Minimum certainty (0–1)'),
      f.select('searchType', 'Retrieval', [['vector', 'Semantic (vector)'], ['hybrid', 'Hybrid (vector + keyword)'], ['keyword', 'Keyword (BM25)']], { advanced: true }),
      f.json('filters', 'Metadata filter', { advanced: true }),
      f.area('userTemplate', 'Context template', { advanced: true, help: 'Use {query} and {context}' }),
      { key: 'messages', label: 'Chat history', type: 'messages', advanced: true }, f.text('memories', 'Memories', { advanced: true }),
    ],
    outputs: [{ path: 'modelResponse', type: 'string' }, { path: 'references', type: 'array' }, ...metaOutputs],
    defaults: () => ({ nodeName: 'RAG', queryField: '{{triggerNode_1.output.question}}', vectorDB: '', limit: 4, certainty: '0.5', filters: '', searchType: 'vector', prompts: [{ id: 'system', role: 'system', content: 'Answer using only the provided documents. If they do not contain the answer, say so.' }], memories: '[]', messages: '[]' }),
  },
  validate(node) {
    const out: Diagnostic[] = [];
    if (!node.values['queryField']) out.push({ severity: 'error', code: 'FIELD_REQUIRED', message: 'queryField is required', nodeId: node.id });
    if (!node.values['vectorDB'] || (Array.isArray(node.values['vectorDB']) && node.values['vectorDB'].length === 0)) out.push({ severity: 'error', code: 'FIELD_REQUIRED', message: 'vectorDB is required', nodeId: node.id });
    return out;
  },
  async run(ctx) {
    const query = str(val(ctx, 'queryField', ''));
    const collections = (Array.isArray(ctx.values['vectorDB']) ? ctx.values['vectorDB'] : [ctx.values['vectorDB']]).map((c) => str(resolveValue(c, ctx.scope, opts(ctx)))).filter(Boolean);
    const limit = Math.min(Math.max(Math.trunc(num(val(ctx, 'limit'), 4)), 1), 50);
    const certainty = num(val(ctx, 'certainty'), 0);
    const mode = (['vector', 'hybrid', 'keyword'].includes(String(ctx.values['searchType'])) ? ctx.values['searchType'] : 'vector') as 'vector' | 'hybrid' | 'keyword';
    const filter = parseFilterValue(ctx);
    let usage: Partial<Usage> = {};
    const models: string[] = [];
    const references: Record<string, unknown>[] = [];
    for (const collection of collections) {
      const r = await retrieve(ctx, { collection, query, mode, limit, ...(mode !== 'keyword' ? { certainty } : {}), filter });
      usage = addUsage(usage, r.usage);
      models.push(...r.models);
      references.push(...r.hits.map(toSearchResult));
    }
    references.sort((a, b) => Number(b['score'] ?? 0) - Number(a['score'] ?? 0));
    const top = references.slice(0, limit);
    const context = top.length ? top.map((r, i) => `[${i + 1}] ${textForContext(r)}`).join('\n\n') : '(no relevant documents found)';
    const template = str(ctx.values['userTemplate']) || 'Documents:\n{context}\n\nQuestion: {query}';
    const userMessage = template.replace(/\{query\}/g, query).replace(/\{context\}/g, context);
    const hasPrompts = Array.isArray(ctx.values['prompts']) && (ctx.values['prompts'] as unknown[]).length > 0;
    const messages = hasPrompts ? buildMessages(ctx, userMessage) : [{ role: 'system' as const, content: 'Answer using only the provided documents. If they do not contain the answer, say so.' }, { role: 'user' as const, content: userMessage }];
    const res = await generate(ctx, { messages, stream: true });
    usage = addUsage(usage, usageOf(res));
    models.push(modelLabel(res.connectionId, res.model));
    return { output: { modelResponse: res.text, references: top, _meta: meta(res) }, usage, models };
  },
};

function textForContext(r: Record<string, unknown>): string {
  const body = str(r['content'] ?? r['pageContent'] ?? r['text'] ?? '');
  const title = r['title'] ?? r['source'] ?? r['filename'];
  return title ? `${str(title)}\n${body}` : body;
}

/** Filters are JSON (often strings with templates inside values): parse first, then resolve. */
export function parseFilterValue(ctx: NodeContext, key = 'filters'): MetadataFilter | undefined {
  const raw = ctx.values[key];
  if (raw === undefined || raw === null || raw === '' || raw === '[]' || raw === '{}') return undefined;
  return parseFilter(resolveJsonTemplate(raw, ctx.scope, lenient(ctx)));
}

/* ---------------- image generation ---------------- */

const imageHandler: NodeHandler = {
  type: 'ImageGenNode',
  kind: 'action',
  spec: {
    label: 'Generate Image', category: 'ai', icon: 'image',
    description: 'Generate an image with a local OpenAI-compatible image server (LocalAI, Stable Diffusion API bridges).',
    fields: [{ key: 'imageGenModelName', label: 'Image model', type: 'model' }, { key: 'prompts', label: 'Prompt', type: 'prompts', required: true }, f.select('size', 'Size', ['512x512', '768x768', '1024x1024'])],
    outputs: [{ path: 'imageUrl', type: 'string', description: 'data: URL of the generated image' }],
    defaults: () => ({ nodeName: 'Generate Image', prompts: [{ id: 'user', role: 'user', content: '{{triggerNode_1.output.prompt}}' }], size: '512x512' }),
  },
  validate: promptValidate,
  async run(ctx) {
    const prompt = buildMessages(ctx).filter((m) => m.role !== 'assistant').map((m) => m.content).join('\n');
    const ref = modelConfigs(ctx.values['imageGenModelName'])[0] ?? {};
    const target = await ctx.services.llm.resolve(ref, 'chat', ctx.signal);
    if (!target.provider.generateImage) throw new EngineError('PROVIDER', `Connection ${target.connectionId} cannot generate images; use an OpenAI-compatible server with /images/generations`);
    const image = await target.provider.generateImage({ model: target.model, prompt, size: str(ctx.values['size']) || '512x512', signal: ctx.signal });
    return { output: { imageUrl: image.url }, models: [modelLabel(target.connectionId, target.model)] };
  },
};

export const aiHandlers: NodeHandler[] = [llmHandler, multiModalHandler, instructorHandler, classifierHandler, agentHandler, agentEndHandler, ragHandler, imageHandler];
