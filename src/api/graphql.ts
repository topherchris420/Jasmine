import { buildSchema, graphql, GraphQLError, type ExecutionResult, type GraphQLObjectType } from 'graphql';
import { toEngineError } from '../errors.ts';
import type { DeploymentRegistry, DeployResult } from '../service/deployments.ts';
import type { RunService } from '../service/runs.ts';

export const typeDefs = /* GraphQL */ `
  scalar JSON
  enum RunMode { realtime async }

  type ExecError { code: String! message: String! nodeId: String retryable: Boolean! }
  type ExecuteResult { status: String! requestId: String! result: JSON error: ExecError }
  type Diagnostic { severity: String! code: String! message: String! nodeId: String }
  type DeployResult { workflowId: String! version: String! previousVersion: String changed: Boolean! diagnostics: [Diagnostic!]! }
  type FlowVersion { version: String! deployedAt: String! active: Boolean! }

  type Query {
    "Studio-compatible entry point. Prefer Mutation.executeWorkflow: running a flow has side effects."
    executeWorkflow(workflowId: String!, payload: JSON, idempotencyKey: String, mode: RunMode): ExecuteResult!
    checkStatus(requestId: String!): ExecuteResult!
    flowVersions(workflowId: String!): [FlowVersion!]!
    runTrace(requestId: String!): JSON!
    runHistory(workflowId: String!): [ExecuteResult!]!
  }

  type Mutation {
    executeWorkflow(workflowId: String!, payload: JSON, idempotencyKey: String, mode: RunMode): ExecuteResult!
    retryWorkflow(requestId: String!): ExecuteResult!
    cancelWorkflow(requestId: String!): Boolean!
    deployFlow(workflowId: String!, definition: JSON!, expectedVersion: String): DeployResult!
    rollbackFlow(workflowId: String!, toVersion: String, expectedVersion: String): DeployResult!
  }
`;

function asGraphQLError(err: unknown): GraphQLError {
  const e = toEngineError(err);
  const extensions: Record<string, unknown> = { code: e.code, retryable: e.retryable };
  if (e.nodeId) extensions['nodeId'] = e.nodeId;
  if (e.code === 'COMPILE') extensions['diagnostics'] = e.details;
  return new GraphQLError(e.message, { extensions });
}

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw asGraphQLError(err);
  }
}

const deployView = (r: DeployResult) => ({ workflowId: r.flowId, version: r.version, previousVersion: r.previousVersion, changed: r.changed, diagnostics: r.diagnostics });

export function createApi(deployments: DeploymentRegistry, runs: RunService) {
  type Args = Record<string, unknown>;
  const execute = (a: Args) =>
    guard(() => runs.executeWorkflow(a['workflowId'] as string, a['payload'] ?? {}, {
      ...(a['idempotencyKey'] ? { idempotencyKey: a['idempotencyKey'] as string } : {}),
      ...(a['mode'] ? { mode: a['mode'] as 'realtime' | 'async' } : {}),
    }));
  const query = {
    executeWorkflow: execute,
    checkStatus: (a: Args) => guard(() => runs.checkStatus(a['requestId'] as string)),
    flowVersions: (a: Args) => deployments.listVersions(a['workflowId'] as string),
    runTrace: (a: Args) => guard(() => runs.trace(a['requestId'] as string)),
    runHistory: (a: Args) => runs.history(a['workflowId'] as string),
  };
  const mutation = {
    executeWorkflow: execute,
    retryWorkflow: (a: Args) => guard(() => runs.retryWorkflow(a['requestId'] as string)),
    cancelWorkflow: (a: Args) => runs.cancel(a['requestId'] as string),
    deployFlow: (a: Args) =>
      guard(async () =>
        deployView(await deployments.deploy(a['workflowId'] as string, a['definition'], a['expectedVersion'] !== undefined ? { expectedVersion: a['expectedVersion'] as string | null } : {})),
      ),
    rollbackFlow: (a: Args) =>
      guard(() =>
        deployView(deployments.rollback(a['workflowId'] as string, {
          ...(a['toVersion'] ? { toVersion: a['toVersion'] as string } : {}),
          ...(a['expectedVersion'] !== undefined ? { expectedVersion: a['expectedVersion'] as string | null } : {}),
        })),
      ),
  };

  const schema = buildSchema(typeDefs);
  const bind = (type: GraphQLObjectType | null | undefined, resolvers: Record<string, (args: Args) => unknown>) => {
    const fields = type!.getFields();
    for (const [name, fn] of Object.entries(resolvers)) fields[name]!.resolve = (_source, args) => fn(args as Args);
  };
  bind(schema.getQueryType(), query);
  bind(schema.getMutationType(), mutation);

  return {
    schema,
    execute(source: string, variableValues?: Record<string, unknown>, operationName?: string): Promise<ExecutionResult> {
      return graphql({
        schema,
        source,
        ...(variableValues ? { variableValues } : {}),
        ...(operationName ? { operationName } : {}),
      });
    },
  };
}
