import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Jasmine } from '../app.ts';
import { EngineError } from '../errors.ts';
import { flatSchemaToJsonSchema } from '../nodes/core.ts';
import { HANDLED, type Router } from './http.ts';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  admin?: boolean;
  run: (args: Record<string, unknown>) => unknown;
}
const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
function toolSet(app: Jasmine): Tool[] {
  const tools: Tool[] = [
    {
      name: 'graph_load_project_flows',
      description: 'List active local flows and their input schemas.',
      inputSchema: object(),
      run: () =>
        app.deployments
          .activeFlows()
          .map((d) => ({
            id: d.flowId,
            name: d.plan.definition.name ?? d.flowId,
            version: d.version,
            inputSchema: inputSchema(d.plan.nodes.get(d.plan.triggerId)!.node.values),
          })),
    },
    {
      name: 'graph_refresh_flows',
      description: 'Refresh the deployed flow inventory.',
      inputSchema: object(),
      run: () => app.deployments.activeFlows().map((d) => ({ id: d.flowId, version: d.version })),
    },
    {
      name: 'graph_execute_flow',
      description: 'Execute an active flow through the same runtime as the REST API.',
      inputSchema: object(
        {
          workflowId: string,
          payload: { type: 'object', additionalProperties: true },
          mode: { enum: ['realtime', 'async'] },
          idempotencyKey: string,
        },
        ['workflowId'],
      ),
      run: (a) =>
        app.runs.executeWorkflow(String(a['workflowId']), a['payload'] ?? {}, {
          ...(a['mode'] === 'async' ? { mode: 'async' } : {}),
          ...(typeof a['idempotencyKey'] === 'string' ? { idempotencyKey: a['idempotencyKey'] } : {}),
        }),
    },
    {
      name: 'check_status',
      description: 'Inspect an execution.',
      inputSchema: object({ requestId: string }, ['requestId']),
      run: (a) => app.runs.checkStatus(String(a['requestId'])),
    },
    {
      name: 'query_docs',
      description: 'Search Jasmine documentation and return matching paragraphs with local references.',
      inputSchema: object({ text: string }, ['text']),
      run: async (a) => {
        const query = String(a['text'] ?? '')
          .toLowerCase()
          .split(/\W+/)
          .filter(Boolean);
        const docs = ['CAPABILITIES.md', 'INTEGRATIONS.md', 'PARITY.md'];
        const matches = [];
        for (const name of docs) {
          const content = await readFile(new URL(`../../docs/${name}`, import.meta.url), 'utf8').catch(() => '');
          for (const paragraph of content.split(/\n\s*\n/)) {
            const score = query.filter((w) => paragraph.toLowerCase().includes(w)).length;
            if (score) matches.push({ source: `docs/${name}`, text: paragraph.slice(0, 4000), score });
          }
        }
        return matches.sort((a, b) => b.score - a.score).slice(0, 8);
      },
    },
    {
      name: 'templates_list',
      description: 'List starter templates.',
      inputSchema: object(),
      run: async () => (await app.templates()).map(({ definition, ...meta }) => meta),
    },
    {
      name: 'templates_get',
      description: 'Get a complete template flow.',
      inputSchema: object({ id: string }, ['id']),
      run: async (a) => (await app.templates()).find((t) => t.id === a['id']) ?? null,
    },
    {
      name: 'project_get',
      description: 'Inspect local project metadata.',
      inputSchema: object(),
      admin: true,
      run: () => app.project.info(),
    },
    {
      name: 'flows_list',
      description: 'List local drafts.',
      inputSchema: object(),
      admin: true,
      run: () => app.workspace.list().map((f) => app.flowSummary(f)),
    },
    {
      name: 'flows_get',
      description: 'Read a saved flow definition.',
      inputSchema: object({ id: string }, ['id']),
      admin: true,
      run: (a) => app.workspace.get(String(a['id'])) ?? null,
    },
    {
      name: 'flows_save',
      description: 'Create or update a draft with revision checking. Does not deploy.',
      inputSchema: object(
        {
          id: string,
          name: string,
          definition: { type: 'object', additionalProperties: true },
          expectedRevision: { type: 'integer', minimum: 0 },
        },
        ['id', 'name', 'definition'],
      ),
      admin: true,
      run: (a) =>
        app.workspace.save(
          String(a['id']),
          String(a['name']),
          a['definition'],
          a['expectedRevision'] as number | undefined,
        ),
    },
    {
      name: 'flows_delete',
      description: 'Delete a local flow and its deployments.',
      inputSchema: object({ id: string }, ['id']),
      admin: true,
      run: (a) => app.deleteFlow(String(a['id'])),
    },
    {
      name: 'flows_validate',
      description: 'Compile a proposed flow without executing or deploying.',
      inputSchema: object({ id: string, definition: { type: 'object', additionalProperties: true } }, [
        'id',
        'definition',
      ]),
      admin: true,
      run: (a) => app.deployments.validate(String(a['id']), a['definition']),
    },
    {
      name: 'flows_deploy',
      description: 'Activate a previously saved draft.',
      inputSchema: object({ id: string }, ['id']),
      admin: true,
      run: (a) => app.deployFlow(String(a['id'])),
    },
    {
      name: 'flows_rollback',
      description: 'Activate a stored version.',
      inputSchema: object({ id: string, version: string }, ['id']),
      admin: true,
      run: (a) =>
        app.deployments.rollback(String(a['id']), typeof a['version'] === 'string' ? { toVersion: a['version'] } : {}),
    },
    {
      name: 'contexts_list',
      description: 'List local vector and memory collections.',
      inputSchema: object(),
      admin: true,
      run: () => app.vectors.listCollections(),
    },
    {
      name: 'contexts_create',
      description: 'Create a local collection.',
      inputSchema: object({ name: string, kind: { enum: ['knowledge', 'memory'] } }, ['name']),
      admin: true,
      run: (a) =>
        app.vectors.createCollection({
          name: String(a['name']),
          kind: a['kind'] === 'memory' ? 'memory' : 'knowledge',
        }),
    },
    {
      name: 'models_list',
      description: 'List model connections without secrets.',
      inputSchema: object(),
      admin: true,
      run: () => app.connections.list(),
    },
    {
      name: 'integrations_list',
      description: 'List available integration nodes.',
      inputSchema: object(),
      admin: true,
      run: () =>
        app.registry
          .catalog()
          .filter((n) => n.integration)
          .map((n) => ({ type: n.type, label: n.label, integration: n.integration })),
    },
  ];
  for (const d of app.deployments.activeFlows()) {
    const name = `flow_${d.flowId}`;
    const safe =
      name.length > 64 ? `${name.slice(0, 53)}_${createHash('sha256').update(name).digest('hex').slice(0, 10)}` : name;
    tools.push({
      name: safe,
      description: `Run ${d.plan.definition.name ?? d.flowId} (${d.version})`,
      inputSchema: inputSchema(d.plan.nodes.get(d.plan.triggerId)!.node.values),
      run: (a) => app.runs.executeWorkflow(d.flowId, a),
    });
  }
  return tools;
}
function inputSchema(values: Record<string, unknown>): Record<string, unknown> {
  try {
    const raw = values['advance_schema'];
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (value) return flatSchemaToJsonSchema(value);
  } catch {}
  return { type: 'object', additionalProperties: true };
}

/** Stateless Streamable HTTP JSON-RPC endpoint. API-key scope applies to every tool call. */
export function registerMcp(router: Router, app: Jasmine): void {
  router.post('/mcp', 'execute', async (req) => {
    const msg = await req.json<{
      jsonrpc?: unknown;
      id?: unknown;
      method?: unknown;
      params?: Record<string, unknown>;
    }>();
    const id = msg.id ?? null;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC request' } };
    if (msg.id === undefined) {
      req.res.writeHead(202);
      req.res.end();
      return HANDLED;
    }
    let result: unknown;
    if (msg.method === 'initialize')
      result = {
        protocolVersion: ['2025-03-26', '2025-06-18'].includes(String(msg.params?.['protocolVersion']))
          ? String(msg.params?.['protocolVersion'])
          : '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: {} },
        serverInfo: { name: 'Jasmine', version: '1.1.0' },
      };
    else if (msg.method === 'ping') result = {};
    else if (msg.method === 'tools/list')
      result = {
        tools: toolSet(app)
          .filter((t) => !t.admin || req.scope === 'admin')
          .map(({ run, admin, ...spec }) => spec),
      };
    else if (msg.method === 'resources/list')
      result = { resources: [{ uri: 'jasmine://catalog', name: 'Node catalog', mimeType: 'application/json' }] };
    else if (msg.method === 'resources/read') {
      if (msg.params?.['uri'] !== 'jasmine://catalog')
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown resource' } };
      result = {
        contents: [
          {
            uri: 'jasmine://catalog',
            mimeType: 'application/json',
            text: JSON.stringify(
              app.registry.catalog().map((n) => ({ type: n.type, label: n.label, description: n.description })),
            ),
          },
        ],
      };
    } else if (msg.method === 'tools/call') {
      const tool = toolSet(app).find((t) => t.name === msg.params?.['name']);
      if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } };
      if (tool.admin && req.scope !== 'admin')
        throw new EngineError('FORBIDDEN', 'This tool requires an admin API key');
      const args = msg.params?.['arguments'] ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args))
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Tool arguments must be an object' } };
      const { validateJsonSchema } = await import('../nodes/jsonschema.ts');
      const errors = validateJsonSchema(args, tool.inputSchema);
      if (errors.length) return { jsonrpc: '2.0', id, error: { code: -32602, message: errors.join('; ') } };
      try {
        const value = await tool.run(args as Record<string, unknown>);
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (e) {
        result = {
          isError: true,
          content: [{ type: 'text', text: e instanceof EngineError ? e.message : 'Tool failed' }],
        };
      }
    } else return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    return { jsonrpc: '2.0', id, result };
  });
}
