import { buildSchema, execute as executeDocument, GraphQLError, Kind, parse, validate, type DocumentNode, type ExecutionResult, type GraphQLObjectType, type SelectionSetNode } from 'graphql';
import { EngineError, toEngineError } from '../errors.ts';
import type { DeploymentRegistry, DeployResult } from '../service/deployments.ts';
import type { RunService } from '../service/runs.ts';

export const typeDefs = /* GraphQL */ `
  scalar JSON
  enum RunMode { realtime async }

  type ExecError { code: String! message: String! nodeId: String retryable: Boolean! }
  "result is the flow output on success, or { requestId } while an async run is in progress."
  type ExecuteResult {
    cached: Boolean
    status: String!
    requestId: String!
    result: JSON
    output: JSON
    input: JSON
    statusCode: Int
    timeTakenInSeconds: Float
    version: String
    usage: JSON
    models: [String!]
    nodes: JSON
    error: ExecError
    message: String
  }
  type Diagnostic { severity: String! code: String! message: String! nodeId: String }
  type DeployResult { workflowId: String! version: String! previousVersion: String changed: Boolean! diagnostics: [Diagnostic!]! }
  type FlowVersion { version: String! deployedAt: String! active: Boolean! }

  type Query {
    "Jasmine entry point. Mutation.executeWorkflow is equivalent and preferred: running a flow has side effects."
    executeWorkflow(workflowId: String!, payload: JSON, idempotencyKey: String, mode: RunMode, version: String): ExecuteResult!
    checkStatus(requestId: String!): ExecuteResult!
    flowVersions(workflowId: String!): [FlowVersion!]!
    runTrace(requestId: String!): JSON!
    runHistory(workflowId: String!): [ExecuteResult!]!
  }

  type FeedbackResult { success: Boolean! message: String! data: JSON error: JSON }
  type Mutation {
    submitFeedback(requestId: String, requestIds: [String!], rating: Int, weight: Float, comment: String, metadata: JSON): FeedbackResult!
    executeWorkflow(workflowId: String!, payload: JSON, idempotencyKey: String, mode: RunMode, version: String): ExecuteResult!
    retryWorkflow(requestId: String!): ExecuteResult!
    cancelWorkflow(requestId: String!): Boolean!
    deployFlow(workflowId: String!, definition: JSON!, expectedVersion: String): DeployResult!
    rollbackFlow(workflowId: String!, toVersion: String, expectedVersion: String): DeployResult!
  }
`;

export interface ApiContext {
  scope: 'admin' | 'execute' | 'public';
  bypassCache?:boolean;
}

function asGraphQLError(err: unknown): GraphQLError {
  const e = toEngineError(err);
  const internal = e.code === 'INTERNAL' && !(err instanceof EngineError);
  const extensions: Record<string, unknown> = { code: e.code, retryable: e.retryable };
  if (e.nodeId) extensions['nodeId'] = e.nodeId;
  if (e.code === 'COMPILE') extensions['diagnostics'] = e.details;
  return new GraphQLError(internal ? 'Internal server error' : e.message, { extensions });
}

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw asGraphQLError(err);
  }
}

const deployView = (r: DeployResult) => ({ workflowId: r.flowId, version: r.version, previousVersion: r.previousVersion, changed: r.changed, diagnostics: r.diagnostics });

function requireAdmin(ctx: ApiContext | undefined, what = 'Deploying') {
  if (ctx && ctx.scope !== 'admin') throw new EngineError('FORBIDDEN', `${what} needs an admin API key`);
}

/** Query budget. Validation of repeated fields is quadratic in graphql-js, so documents are bounded before validate(). */
export const QUERY_LIMITS = { maxQueryBytes: 65_536, maxTokens: 5_000, maxFields: 500, maxRepeats: 10, maxDepth: 20, maxMergeCost: 2_000 };

const queryError = (message: string): ExecutionResult => ({ errors: [new GraphQLError(message, { extensions: { code: 'BAD_PAYLOAD', retryable: false } })] });

class QueryTooComplex extends Error {}

/**
 * Bounds the work of graphql-js validation before it runs. Fields are counted after fragment expansion,
 * and fields sharing a response name in one selection set (which validation compares pairwise, recursing
 * into their sub-selections) are charged the product of their subtree sizes per pair.
 */
export function checkQueryComplexity(document: DocumentNode, limits = QUERY_LIMITS): string | undefined {
  const fragments = new Map<string, SelectionSetNode>();
  for (const d of document.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d.selectionSet);
  let budget = limits.maxFields;
  let mergeCost = 0;
  const fail = (message: string): never => {
    throw new QueryTooComplex(message);
  };
  /** Returns the number of fields in the selection set's expanded subtree. */
  const visit = (set: SelectionSetNode, depth: number, active: Set<string>): number => {
    if (depth > limits.maxDepth) fail(`Query is nested deeper than ${limits.maxDepth} levels`);
    const groups = new Map<string, number[]>();
    let total = 0;
    const collect = (selections: SelectionSetNode, seen: Set<string>) => {
      for (const sel of selections.selections) {
        if (--budget < 0) fail(`Query selects more than ${limits.maxFields} fields`);
        if (sel.kind === Kind.FIELD) {
          const name = sel.alias?.value ?? sel.name.value;
          const weights = groups.get(name) ?? [];
          if (weights.length >= limits.maxRepeats) fail(`Field "${name}" is selected more than ${limits.maxRepeats} times; use aliases`);
          const weight = 1 + (sel.selectionSet ? visit(sel.selectionSet, depth + 1, seen) : 0);
          for (const w of weights) mergeCost += w * weight;
          if (mergeCost > limits.maxMergeCost) fail(`Query repeats fields with nested selections too often; use aliases`);
          weights.push(weight);
          groups.set(name, weights);
          total += weight;
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
          collect(sel.selectionSet, seen);
        } else {
          const fragment = fragments.get(sel.name.value);
          if (fragment && !seen.has(sel.name.value)) collect(fragment, new Set([...seen, sel.name.value]));
        }
      }
    };
    collect(set, active);
    return total;
  };
  try {
    for (const d of document.definitions) {
      if (d.kind === Kind.OPERATION_DEFINITION) visit(d.selectionSet, 1, new Set());
      // Validation also walks fragment definitions on their own, used or not.
      else if (d.kind === Kind.FRAGMENT_DEFINITION) visit(d.selectionSet, 1, new Set([d.name.value]));
    }
  } catch (e) {
    if (e instanceof QueryTooComplex) return e.message;
    throw e;
  }
  return undefined;
}

export function createApi(deployments: DeploymentRegistry, runs: RunService, feedback?: import('../service/feedback.ts').FeedbackStore) {
  type Args = Record<string, unknown>;
  const execute = (a: Args,ctx?:ApiContext) =>
    guard(() => runs.executeWorkflow(a['workflowId'] as string, a['payload'] ?? {}, {
      ...(a['idempotencyKey'] ? { idempotencyKey: a['idempotencyKey'] as string } : {}),
      ...(a['mode'] ? { mode: a['mode'] as 'realtime' | 'async' } : {}),
      source: 'api',
      bypassCache:ctx?.bypassCache??false,
      ...(typeof a['version']==='string'?{version:a['version']}:{}),
    }));
  const query: Record<string, (args: Args, ctx?: ApiContext) => unknown> = {
    executeWorkflow: execute,
    checkStatus: (a) => guard(() => runs.checkStatus(a['requestId'] as string)),
    flowVersions: (a) => deployments.listVersions(a['workflowId'] as string),
    runTrace: (a) => guard(() => runs.trace(a['requestId'] as string)),
    // Every caller's inputs and outputs for a flow: the same data as the admin-only run log.
    runHistory: (a, ctx) => guard(() => {
      requireAdmin(ctx, 'Reading run history');
      return runs.history(a['workflowId'] as string);
    }),
  };
  const mutation: Record<string, (args: Args, ctx?: ApiContext) => unknown> = {
    submitFeedback: (a) => guard(()=>{if(!feedback)throw new EngineError('NOT_FOUND','Feedback is not configured');return feedback.submit(a);}),
    executeWorkflow: execute,
    retryWorkflow: (a) => guard(() => runs.retryWorkflow(a['requestId'] as string)),
    cancelWorkflow: (a) => runs.cancel(a['requestId'] as string),
    deployFlow: (a, ctx) =>
      guard(async () => {
        requireAdmin(ctx);
        return deployView(await deployments.deploy(a['workflowId'] as string, a['definition'], a['expectedVersion'] !== undefined ? { expectedVersion: a['expectedVersion'] as string | null } : {}));
      }),
    rollbackFlow: (a, ctx) =>
      guard(() => {
        requireAdmin(ctx);
        return deployView(deployments.rollback(a['workflowId'] as string, {
          ...(a['toVersion'] ? { toVersion: a['toVersion'] as string } : {}),
          ...(a['expectedVersion'] !== undefined ? { expectedVersion: a['expectedVersion'] as string | null } : {}),
        }));
      }),
  };

  const schema = buildSchema(typeDefs);
  const bind = (type: GraphQLObjectType | null | undefined, resolvers: Record<string, (args: Args, ctx?: ApiContext) => unknown>) => {
    const fields = type!.getFields();
    for (const [name, fn] of Object.entries(resolvers)) fields[name]!.resolve = (_source, args, ctx) => fn(args as Args, ctx as ApiContext | undefined);
  };
  bind(schema.getQueryType(), query);
  bind(schema.getMutationType(), mutation);

  return {
    schema,
    async execute(source: string, variableValues?: Record<string, unknown>, operationName?: string, context?: ApiContext): Promise<ExecutionResult> {
      if (Buffer.byteLength(source) > QUERY_LIMITS.maxQueryBytes) return queryError(`Query exceeds ${QUERY_LIMITS.maxQueryBytes} bytes`);
      let document: DocumentNode;
      try {
        document = parse(source, { maxTokens: QUERY_LIMITS.maxTokens });
      } catch (e) {
        if (e instanceof GraphQLError) return { errors: [e] };
        throw e;
      }
      const tooComplex = checkQueryComplexity(document);
      if (tooComplex) return queryError(tooComplex);
      const errors = validate(schema, document);
      if (errors.length) return { errors };
      return executeDocument({
        schema,
        document,
        ...(variableValues ? { variableValues } : {}),
        ...(operationName ? { operationName } : {}),
        ...(context ? { contextValue: context } : {}),
      });
    },
  };
}
