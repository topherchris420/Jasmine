import type http from 'node:http';
import { readFile } from 'node:fs/promises';
import { EngineError } from '../errors.ts';
import type { WorkspaceStore } from '../service/workspace.ts';
import type { DeploymentRegistry } from '../service/deployments.ts';
import type { RunService } from '../service/runs.ts';

export interface StudioOptions {
  workspace: WorkspaceStore;
  deployments: DeploymentRegistry;
  runs: RunService;
  model: string;
  provider: string;
}

const assets: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html'],
  '/onboarding/select-flow': ['index.html', 'text/html'],
  '/studio': ['workspace.html', 'text/html'],
  '/docs': ['docs.html', 'text/html'],
  '/studio.css': ['studio.css', 'text/css'],
  '/studio.js': ['studio.js', 'text/javascript'],
  '/workspace.css': ['workspace.css', 'text/css'],
  '/workspace.js': ['workspace.js', 'text/javascript'],
};

export async function serveStudioAsset(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const asset = assets[pathname];
  if (!asset) return false;
  const body = await readFile(new URL(`../../public/${asset[0]}`, import.meta.url));
  res.writeHead(200, {
    'content-type': `${asset[1]}; charset=utf-8`, 'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

export async function handleStudioApi(method: string | undefined, pathname: string, body: unknown, studio: StudioOptions): Promise<unknown> {
  if (method === 'GET' && pathname === '/api/studio') {
    return { flows: studio.workspace.list(), model: studio.model, provider: studio.provider, load: studio.runs.load };
  }
  const match = /^\/api\/studio\/flows\/([A-Za-z0-9_-]{1,100})(\/deploy)?$/.exec(pathname);
  if (!match) throw new EngineError('NOT_FOUND', 'Studio endpoint not found');
  const id = match[1]!;
  if (method === 'PUT' && !match[2]) {
    const value = body as { name?: unknown; definition?: unknown; expectedRevision?: unknown } | null;
    if (!value || typeof value.name !== 'string' || (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0))) throw new EngineError('BAD_PAYLOAD', 'Invalid draft payload');
    return studio.workspace.save(id, value.name, value.definition, value.expectedRevision as number | undefined);
  }
  if (method === 'POST' && match[2]) {
    const draft = studio.workspace.get(id);
    if (!draft) throw new EngineError('NOT_FOUND', 'Flow not found');
    const deployed = await studio.deployments.deploy(id, draft.definition);
    await studio.workspace.markDeployed(id, draft.definition, deployed.version);
    return deployed;
  }
  throw new EngineError('NOT_FOUND', 'Studio endpoint not found');
}
