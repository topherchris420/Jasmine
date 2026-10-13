import { timingSafeEqual } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AnthropicProvider, MockLLMProvider, StaticLLMRouter, type LLMProvider } from '../llm/providers.ts';
import { defaultRegistry } from '../nodes/builtin.ts';
import { DeploymentRegistry } from '../service/deployments.ts';
import { RunService } from '../service/runs.ts';
import { createApi } from './graphql.ts';

export interface ServerOptions {
  apiKey?: string;
  projectId?: string;
  maxBodyBytes?: number;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const errorBody = (code: string, message: string) => ({ errors: [{ message, extensions: { code } }] });

export function createServer(api: ReturnType<typeof createApi>, opts: ServerOptions = {}): http.Server {
  const maxBody = opts.maxBodyBytes ?? 1_000_000;
  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://x').pathname !== '/graphql') {
      return send(res, 404, errorBody('NOT_FOUND', 'POST /graphql'));
    }
    if (opts.apiKey && !safeEqual(req.headers.authorization ?? '', `Bearer ${opts.apiKey}`)) {
      return send(res, 403, errorBody('FORBIDDEN', 'Invalid API key'));
    }
    if (opts.projectId && req.headers['x-project-id'] !== opts.projectId) {
      return send(res, 403, errorBody('FORBIDDEN', 'Invalid x-project-id'));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBody) return send(res, 413, errorBody('PAYLOAD_TOO_LARGE', `Body exceeds ${maxBody} bytes`));
      chunks.push(chunk as Buffer);
    }
    let body: { query?: unknown; variables?: unknown; operationName?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(res, 400, errorBody('BAD_REQUEST', 'Body must be JSON'));
    }
    if (typeof body.query !== 'string') return send(res, 400, errorBody('BAD_REQUEST', 'Missing query'));
    const result = await api.execute(
      body.query,
      body.variables && typeof body.variables === 'object' ? (body.variables as Record<string, unknown>) : undefined,
      typeof body.operationName === 'string' ? body.operationName : undefined,
    );
    send(res, 200, result);
  });
}

async function main() {
  const env = process.env;
  const llm: LLMProvider = env['LLM_PROVIDER'] === 'anthropic' ? new AnthropicProvider() : new MockLLMProvider({ latencyMs: 50 });
  const services = {
    llm: new StaticLLMRouter({ [llm.name]: llm }, llm.name, env['DEFAULT_MODEL'] ?? 'claude-opus-5-5'),
    fetch: globalThis.fetch,
    codeTimeoutMs: 5_000,
  };
  const deployments = new DeploymentRegistry(defaultRegistry());
  const runs = new RunService(deployments, { services });
  const flowsDir = env['FLOWS_DIR'];
  if (flowsDir) {
    for (const file of (await readdir(flowsDir)).filter((f) => f.endsWith('.json'))) {
      const id = path.basename(file, '.json');
      const r = await deployments.deploy(id, JSON.parse(await readFile(path.join(flowsDir, file), 'utf8')));
      console.log(`deployed ${id} ${r.version} (${r.diagnostics.length} diagnostics)`);
    }
  }
  const port = Number(env['PORT'] ?? 8787);
  const serverOpts: ServerOptions = {};
  if (env['LAMATIC_API_KEY']) serverOpts.apiKey = env['LAMATIC_API_KEY'];
  if (env['LAMATIC_PROJECT_ID']) serverOpts.projectId = env['LAMATIC_PROJECT_ID'];
  createServer(createApi(deployments, runs), serverOpts).listen(port, () => {
    console.log(`lamatic-engine listening on http://localhost:${port}/graphql (LLM provider: ${llm.name})`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
