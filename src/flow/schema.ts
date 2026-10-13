import { z } from 'zod';

/* ---------- Studio export format (what Lamatic Studio / AgentKit `flows/*.ts` contain) ---------- */

export const StudioNodeSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().default('dynamicNode'),
  data: z.looseObject({
    nodeId: z.string().min(1),
    trigger: z.boolean().optional(),
    values: z.record(z.string(), z.unknown()).default({}),
    logic: z.array(z.unknown()).optional(),
  }),
});

export const StudioEdgeSchema = z.looseObject({
  id: z.string().optional(),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullish(),
  targetHandle: z.string().nullish(),
  type: z.string().default('defaultEdge'),
});

export const StudioFlowSchema = z.looseObject({
  meta: z.looseObject({ name: z.string().optional() }).optional(),
  nodes: z.array(StudioNodeSchema),
  edges: z.array(StudioEdgeSchema).default([]),
});

export type StudioFlow = z.input<typeof StudioFlowSchema>;

/* ---------- Engine IR ---------- */

export type EdgeKind = 'default' | 'response' | 'condition' | 'loop' | 'branch';

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  delayMs: z.number().int().min(0).max(30_000),
  backoff: z.enum(['fixed', 'exponential']).default('fixed'),
  jitter: z.boolean().default(false),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const NodeLogicSchema = z.object({
  retry: RetryPolicySchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  fallback: z
    .object({ timeoutMs: z.number().int().positive(), values: z.record(z.string(), z.unknown()) })
    .optional(),
});
export type NodeLogic = z.infer<typeof NodeLogicSchema>;

export const FlowNodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z_$][\w$-]*$/, 'node id must be a valid reference identifier'),
  type: z.string().min(1),
  name: z.string().optional(),
  trigger: z.boolean().default(false),
  values: z.record(z.string(), z.unknown()).default({}),
  logic: NodeLogicSchema.optional(),
});
export type FlowNode = z.infer<typeof FlowNodeSchema>;

export const FlowEdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  kind: z.enum(['default', 'response', 'condition', 'loop', 'branch']).default('default'),
  /** For condition edges: the `value` of the condition that activates this edge. */
  branch: z.string().optional(),
});
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

export const FlowDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  nodes: z.array(FlowNodeSchema).min(1),
  edges: z.array(FlowEdgeSchema).default([]),
});
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
}
