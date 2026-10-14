import { timingSafeEqual } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AnthropicProvider, LocalLLMProvider, MockLLMProvider, StaticLLMRouter, type LLMProvider } from '../llm/providers.ts';
import { defaultRegistry } from '../nodes/builtin.ts';
import { DeploymentRegistry } from '../service/deployments.ts';
import { RunService } from '../service/runs.ts';
import { createApi } from './graphql.ts';
import { handleStudioApi, serveStudioAsset, type StudioOptions } from './studio.ts';
import { WorkspaceStore } from '../service/workspace.ts';
import { EngineError } from '../errors.ts';

export interface ServerOptions {
  apiKey?: string;
  projectId?: string;
  maxBodyBytes?: number;
  studio?: StudioOptions;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  if (res.destroyed || res.writableEnded) return;
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json);
}

const errorBody = (code: string, message: string) => ({ errors: [{ message, extensions: { code } }] });

export function createServer(api: ReturnType<typeof createApi>, opts: ServerOptions = {}): http.Server {
  const maxBody = opts.maxBodyBytes ?? 1_000_000;
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (await serveStudioAsset(req, res)) return;
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const studioRequest = !!opts.studio && pathname.startsWith('/api/studio');
    if (!studioRequest && (req.method !== 'POST' || pathname !== '/graphql')) {
      return send(res, 404, errorBody('NOT_FOUND', 'POST /graphql'));
    }
    if (opts.apiKey && !safeEqual(req.headers.authorization ?? '', `Bearer ${opts.apiKey}`)) {
      return send(res, 403, errorBody('FORBIDDEN', 'Invalid API key'));
    }
    if (opts.projectId && req.headers['x-project-id'] !== opts.projectId) {
      return send(res, 403, errorBody('FORBIDDEN', 'Invalid x-project-id'));
    }
    if (studioRequest && req.method === 'GET') {
      return send(res, 200, await handleStudioApi(req.method, pathname, undefined, opts.studio!));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += (chunk as Buffer).length;
      if (size > maxBody) {
        send(res, 413, errorBody('PAYLOAD_TOO_LARGE', `Body exceeds ${maxBody} bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(res, 400, errorBody('BAD_REQUEST', 'Body must be JSON'));
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return send(res, 400, errorBody('BAD_REQUEST', 'Body must be a JSON object'));
    }
    if (studioRequest) return send(res, 200, await handleStudioApi(req.method, pathname, parsed, opts.studio!));
    const body = parsed as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (body.variables != null && (typeof body.variables !== 'object' || Array.isArray(body.variables))) {
      return send(res, 400, errorBody('BAD_REQUEST', 'Variables must be an object or null'));
    }
    if (body.operationName != null && typeof body.operationName !== 'string') {
      return send(res, 400, errorBody('BAD_REQUEST', 'Operation name must be a string or null'));
    }
    if (typeof body.query !== 'string') return send(res, 400, errorBody('BAD_REQUEST', 'Missing query'));
    const result = await api.execute(
      body.query,
      body.variables == null ? undefined : body.variables as Record<string, unknown>,
      typeof body.operationName === 'string' ? body.operationName : undefined,
    );
    send(res, 200, result);
  }
  return http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (req.destroyed && !req.complete) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof EngineError) {
        const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : error.code === 'BAD_PAYLOAD' || error.code === 'COMPILE' ? 400 : 500;
        send(res, status, { errors: [{ message: error.message, extensions: { code: error.code, diagnostics: error.details } }] });
      } else send(res, 500, errorBody('INTERNAL_ERROR', 'Internal server error'));
    });
  });
}

async function main() {
  const env = process.env;
  const provider = env['LLM_PROVIDER'] ?? 'local';
  if (!['local', 'mock', 'anthropic'].includes(provider)) throw new Error('LLM_PROVIDER must be local, mock, or anthropic');
  const structuredOutput = env['LLM_JSON_MODE'] ?? 'json_schema';
  if (structuredOutput !== 'json_schema' && structuredOutput !== 'json_object') throw new Error('LLM_JSON_MODE must be json_schema or json_object');
  const llm: LLMProvider = provider === 'anthropic' ? new AnthropicProvider()
    : provider === 'mock' ? new MockLLMProvider({ latencyMs: 50 })
    : new LocalLLMProvider({
      ...(env['LLM_BASE_URL'] ? { baseURL: env['LLM_BASE_URL'] } : {}),
      ...(env['LLM_MODEL'] ? { model: env['LLM_MODEL'] } : {}),
      ...(env['LLM_API_KEY'] ? { apiKey: env['LLM_API_KEY'] } : {}),
      structuredOutput,
    });
  const services = {
    llm: new StaticLLMRouter({ [llm.name]: llm }, llm.name, env['LLM_MODEL'] ?? env['DEFAULT_MODEL'] ?? (provider === 'local' ? 'auto' : provider === 'mock' ? 'mock-model' : 'claude-opus-5-5')),
    fetch: globalThis.fetch,
    codeTimeoutMs: 5_000,
  };
  const deployments = new DeploymentRegistry(defaultRegistry());
  const runs = new RunService(deployments, { services });
  const workspace = new WorkspaceStore(env['JASMINE_DATA_DIR'] ?? path.resolve('.jasmine'));
  await workspace.load();
  if (workspace.list().length === 0) {
    const definition: unknown = JSON.parse(await readFile(new URL('../../examples/local-chat.json', import.meta.url), 'utf8'));
    await workspace.save('getting-started', '1 - Getting Started', definition);
  }
  for (const flow of workspace.list()) {
    if (flow.deployedDefinition !== undefined) await deployments.deploy(flow.id, flow.deployedDefinition);
  }
  const flowsDir = env['FLOWS_DIR'];
  if (flowsDir) {
    for (const file of (await readdir(flowsDir)).filter((f) => f.endsWith('.json'))) {
      const id = path.basename(file, '.json');
      const r = await deployments.deploy(id, JSON.parse(await readFile(path.join(flowsDir, file), 'utf8')));
      console.log(`deployed ${id} ${r.version} (${r.diagnostics.length} diagnostics)`);
    }
  }
  const port = Number(env['PORT'] ?? 8787);
  const host = env['HOST'] ?? '127.0.0.1';
  const serverOpts: ServerOptions = {};
  serverOpts.studio = { workspace, deployments, runs, provider, model: env['LLM_MODEL'] ?? 'auto' };
  if (env['JASMINE_API_KEY']) serverOpts.apiKey = env['JASMINE_API_KEY'];
  if (env['JASMINE_PROJECT_ID']) serverOpts.projectId = env['JASMINE_PROJECT_ID'];
  createServer(createApi(deployments, runs), serverOpts).listen(port, host, () => {
    console.log(`Jasmine listening on http://${host.includes(':') ? `[${host}]` : host}:${port}/graphql (LLM provider: ${llm.name})`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
