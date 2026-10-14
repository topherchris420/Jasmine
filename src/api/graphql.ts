import { buildSchema, graphql, GraphQLError, type ExecutionResult, type GraphQLObjectType } from 'graphql';
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

function requireAdmin(ctx: ApiContext | undefined) {
  if (ctx && ctx.scope !== 'admin') throw new EngineError('FORBIDDEN', 'Deploying needs an admin API key');
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
    runHistory: (a) => runs.history(a['workflowId'] as string),
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
    execute(source: string, variableValues?: Record<string, unknown>, operationName?: string, context?: ApiContext): Promise<ExecutionResult> {
      return graphql({
        schema,
        source,
        ...(variableValues ? { variableValues } : {}),
        ...(operationName ? { operationName } : {}),
        ...(context ? { contextValue: context } : {}),
      });
    },
  };
}
