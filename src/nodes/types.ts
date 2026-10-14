import type { Diagnostic, FlowNode } from '../flow/schema.ts';
import type { Scope } from '../flow/template.ts';
import type { LLMRouter } from '../llm/router.ts';
import type { CredentialResolver } from '../service/credentials.ts';
import type { VectorStore } from '../vector/store.ts';

export type NodeKind = 'trigger' | 'response' | 'condition' | 'loopStart' | 'loopEnd' | 'agentStart' | 'agentEnd' | 'action';

export interface Usage {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/** Runs another deployed flow (flowNode, flows used as agent tools). */
export type FlowInvoker = (flowId: string, payload: unknown, signal: AbortSignal) => Promise<{ status: string; output: unknown; error?: { message: string } }>;

export interface Services {
  llm: LLMRouter;
  fetch: typeof fetch;
  codeTimeoutMs: number;
  vectors?: VectorStore;
  credentials?: CredentialResolver;
  invokeFlow?: FlowInvoker;
  /** Project secrets for `{{secrets.project.NAME}}`. */
  secrets?: () => Record<string, string>;
  /** Project variables for `{{env.NAME}}`. */
  env?: () => Record<string, string>;
  /** Directory for uploaded files (`file:<id>` URLs). */
  filesDir?: string;
  /** Local data tables (tablesNode). */
  tables?: import('../integrations/tables.ts').TablesStore;
}

export interface NodeEvent {
  type: 'node.token' | 'node.progress';
  data: unknown;
}

export interface NodeContext {
  runId: string;
  flowId: string;
  nodeId: string;
  node: FlowNode;
  attempt: number;
  signal: AbortSignal;
  /** Stable across retries and across retry-from-failed reruns of the same request. */
  idempotencyKey: string;
  /** Node values with fallback overrides applied; templates are NOT yet resolved. */
  values: Record<string, unknown>;
  scope: Scope;
  payload: unknown;
  services: Services;
  strictTemplates: boolean;
  /** Streams progress (tokens, partial status) to live listeners; not stored in the trace. */
  emit: (event: NodeEvent) => void;
}

export interface NodeOutput {
  output: unknown;
  /** Condition nodes: which branch keys are active. */
  branches?: string[];
  usage?: Partial<Usage>;
  /** Models used (connection/model), for monitoring. */
  models?: string[];
}

/* ---------- catalog metadata (drives the Studio's palette and config forms) ---------- */

export type NodeCategory = 'trigger' | 'ai' | 'rag' | 'data' | 'logic' | 'app' | 'response';

export type FieldType =
  | 'text' | 'textarea' | 'code' | 'json' | 'number' | 'boolean' | 'select' | 'multiselect'
  | 'model' | 'embeddingModel' | 'prompts' | 'conditions' | 'classifier' | 'branches' | 'agents' | 'tools'
  | 'messages' | 'mapping' | 'schema' | 'vectorDB' | 'memoryCollection' | 'credential' | 'flow' | 'cron' | 'keyValue' | 'stringList' | 'chatConfig';

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  help?: string;
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  /** Only show when another field has one of these values. */
  showIf?: { key: string; equals: (string | number | boolean)[] };
  /** For `credential` fields: which integration's credentials to offer. */
  integration?: string;
  advanced?: boolean;
}

export interface OutputSpec {
  path: string;
  type: string;
  description?: string;
}

export interface NodeSpec {
  label: string;
  category: NodeCategory;
  description: string;
  /** Short glyph or icon key the Studio maps to an icon. */
  icon: string;
  fields: FieldSpec[];
  outputs: OutputSpec[];
  defaults: () => Record<string, unknown>;
  /** React Flow node `type` used by exports (`dynamicNode` unless special). */
  rfType?: string;
  /** Hidden from the palette (paired end nodes, legacy aliases). */
  hidden?: boolean;
  /** Integration this node belongs to (credentials picker, docs). */
  integration?: string;
  /** Default credential requirements, e.g. ["token"]. */
  credentialFields?: { key: string; label: string; secret?: boolean; placeholder?: string }[];
}

export interface NodeHandler {
  type: string;
  kind: NodeKind;
  spec?: NodeSpec;
  /** True when the node writes to an external system; such nodes are only retried when idempotent. */
  sideEffect?(node: FlowNode): boolean;
  idempotent?(node: FlowNode): boolean;
  validate?(node: FlowNode): Diagnostic[];
  /** Condition nodes: every branch key an outgoing edge may carry. */
  branchKeys?(node: FlowNode): string[];
  /** Loop start nodes: the values to iterate over (one body run each). */
  iterate?(ctx: NodeContext): Promise<{ items: unknown[]; waitMs: number; concurrency?: number }>;
  /** Agent loop start nodes: choose the next sub-agent, or finish. */
  decide?(ctx: NodeContext, history: AgentTurn[]): Promise<AgentDecision>;
  run(ctx: NodeContext): Promise<NodeOutput>;
}

export interface AgentTurn {
  agent: string;
  input: unknown;
  output: unknown;
}

export type AgentDecision =
  | { done: true; finalResponse: unknown; usage?: Partial<Usage> }
  | { done: false; agent: string; input: Record<string, unknown>; usage?: Partial<Usage> };

export class NodeRegistry {
  private readonly handlers = new Map<string, NodeHandler>();

  constructor(handlers: Iterable<NodeHandler> = []) {
    for (const h of handlers) this.register(h);
  }

  register(handler: NodeHandler): this {
    this.handlers.set(handler.type, handler);
    return this;
  }

  get(type: string): NodeHandler | undefined {
    return this.handlers.get(type);
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }

  /** Catalog for the Studio palette. */
  catalog(): (NodeSpec & { type: string; kind: NodeKind })[] {
    return [...this.handlers.values()]
      .filter((h): h is NodeHandler & { spec: NodeSpec } => !!h.spec)
      .map((h) => ({ ...h.spec, type: h.type, kind: h.kind, defaults: h.spec.defaults }));
  }
}
