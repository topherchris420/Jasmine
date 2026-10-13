import type { Diagnostic, FlowNode } from '../flow/schema.ts';
import type { Scope } from '../flow/template.ts';
import type { LLMRouter } from '../llm/providers.ts';

export type NodeKind = 'trigger' | 'response' | 'condition' | 'loopStart' | 'loopEnd' | 'action';

export interface Usage {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Services {
  llm: LLMRouter;
  fetch: typeof fetch;
  codeTimeoutMs: number;
}

export interface NodeContext {
  runId: string;
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
}

export interface NodeOutput {
  output: unknown;
  /** Condition nodes: which branch keys are active. */
  branches?: string[];
  usage?: Partial<Usage>;
}

export interface NodeHandler {
  type: string;
  kind: NodeKind;
  /** True when the node writes to an external system; such nodes are only retried when idempotent. */
  sideEffect?(node: FlowNode): boolean;
  idempotent?(node: FlowNode): boolean;
  validate?(node: FlowNode): Diagnostic[];
  /** Condition nodes: every branch key an outgoing edge may carry. */
  branchKeys?(node: FlowNode): string[];
  /** Loop start nodes: the values to iterate over (one body run each). */
  iterate?(ctx: NodeContext): Promise<{ items: unknown[]; waitMs: number }>;
  run(ctx: NodeContext): Promise<NodeOutput>;
}

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
}
