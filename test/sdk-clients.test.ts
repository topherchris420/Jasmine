import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
// @ts-expect-error standalone ESM script
import { graphqlEndpoint } from '../scripts/parity-compare.mjs';
import { JasmineClient, JasmineError } from '../sdk/jasmine.mjs';
import { hasTools } from '../src/service/cache.ts';
import { createTestApp, withHttp } from './helpers.ts';

const run = promisify(execFile);
const python = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(python, ['--version']).status === 0;

/** A fetch that never answers until its signal aborts. */
const hangingFetch = (async (_url: string, init: RequestInit) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  })) as unknown as typeof fetch;

const delayed = (ms: number, body: string, init: ResponseInit = {}) =>
  (async (_url: string, req: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      req.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(req.signal!.reason);
      });
    });
    return new Response(body, init);
  }) as unknown as typeof fetch;

/** Serves one fixed response for every request; returns its base URL and a close function. */
async function fixedServer(status: number, body: string, type: string) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
}

describe('JavaScript client errors and timeouts', () => {
  it('rejects a stalled request with a TIMEOUT JasmineError', async () => {
    const client = new JasmineClient({ fetch: hangingFetch, timeoutMs: 30 });
    const started = Date.now();
    const error = await client.checkStatus('run').catch((e) => e);
    expect(error).toBeInstanceOf(JasmineError);
    expect(error).toMatchObject({ code: 'TIMEOUT', status: 0 });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('keeps a caller abort distinct from a timeout', async () => {
    const client = new JasmineClient({ fetch: hangingFetch, timeoutMs: 5000 });
    const controller = new AbortController();
    const pending = client.checkStatus('run', { signal: controller.signal }).catch((e) => e);
    controller.abort(new Error('stopped by caller'));
    expect((await pending).message).toBe('stopped by caller');
  });

  it('gives realtime executions the longer execute budget and leaves events() unbounded', async () => {
    const ok = JSON.stringify({ status: 'success', requestId: 'r' });
    const slow = new JasmineClient({ fetch: delayed(120, ok), timeoutMs: 30, executeTimeoutMs: 2000 });
    await expect(slow.executeFlow('f', {})).resolves.toMatchObject({ status: 'success' });
    await expect(slow.executeFlow('f', {}, { mode: 'async' })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const stream = new JasmineClient({ fetch: delayed(120, 'event: done\ndata: {"status":"success"}\n\n'), timeoutMs: 30 });
    const events = [];
    for await (const e of stream.events('r')) events.push(e.event);
    expect(events).toEqual(['done']);
  });

  it('wraps non-JSON bodies from proxies in JasmineError', async () => {
    const proxy = new JasmineClient({ fetch: (async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch });
    const error = await proxy.executeFlow('f', {}).catch((e) => e);
    expect(error).toBeInstanceOf(JasmineError);
    expect(error.status).toBe(502);
    expect(error.message).toContain('HTTP 502');
    expect(error.body).toContain('Bad Gateway');
    const garbled = new JasmineClient({ fetch: (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch });
    await expect(garbled.checkStatus('x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 200 });
  });
});

describe.skipIf(!hasPython)('Python client errors', () => {
  it('raises JasmineError (not JSONDecodeError) for a non-JSON error page', async () => {
    const server = await fixedServer(502, '<html><body>502 Bad Gateway</body></html>', 'text/html');
    try {
      const code =
        'import sys; from sdk.jasmine import JasmineClient, JasmineError\n' +
        'try:\n    JasmineClient(sys.argv[1]).execute_flow("x", {})\n' +
        'except JasmineError as e:\n    print("JasmineError", e.status, "Bad Gateway" in e.body)\n';
      const { stdout } = await run(python, ['-B', '-c', code, server.base], { cwd: path.resolve('.'), timeout: 10000 });
      expect(stdout.trim()).toBe('JasmineError 502 True');
    } finally {
      await server.close();
    }
  });
});

describe('parity comparison endpoints', () => {
  it('accepts a Jasmine base URL as well as its GraphQL URL', () => {
    expect(graphqlEndpoint('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/graphql');
    expect(graphqlEndpoint('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787/graphql');
    expect(graphqlEndpoint('http://127.0.0.1:8787/graphql')).toBe('http://127.0.0.1:8787/graphql');
    expect(graphqlEndpoint('https://ref.example', { jasmine: false })).toBe('https://ref.example/graphql');
    expect(graphqlEndpoint('https://ref.example/v1/query', { jasmine: false })).toBe('https://ref.example/v1/query');
  });
});

describe('response cache and tool-using models', () => {
  it('detects configured tools in arrays and JSON text', () => {
    expect(hasTools({ tools: [{ type: 'http', url: 'https://example.com' }] })).toBe(true);
    expect(hasTools({ tools: '[{"type":"code","code":"return 1"}]' })).toBe(true);
    expect(hasTools({ tools: [] })).toBe(false);
    expect(hasTools({ tools: '[]' })).toBe(false);
    expect(hasTools({})).toBe(false);
  });

  it('never serves a cached response for a flow whose model node has tools', async () => {
    const t = await createTestApp();
    const llm = (tools: unknown) => ({
      nodes: [
        { id: 't', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
        { id: 'a', data: { nodeId: 'LLMNode', values: { prompts: [{ id: 'u', role: 'user', content: 'hi' }], tools } } },
        { id: 'r', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: '{"answer":"{{a.output.generatedResponse}}"}' } } },
      ],
      edges: [
        { source: 't', target: 'a' },
        { source: 'a', target: 'r' },
      ],
    });
    try {
      await withHttp(t.app, async (base) => {
        const client = new JasmineClient({ endpoint: base });
        await t.app.deployments.deploy('plain', llm([]));
        await t.app.deployments.deploy('tools', llm([{ type: 'http', name: 'notify', url: 'https://example.com/hook', method: 'POST' }]));
        for (const id of ['plain', 'tools']) t.app.cache.configure(id, { enabled: true, ttlSeconds: 60 });
        await client.executeFlow('plain', { q: 1 });
        expect((await client.executeFlow('plain', { q: 1 })).cached).toBe(true);
        const first = await client.executeFlow('tools', { q: 1 });
        const second = await client.executeFlow('tools', { q: 1 });
        expect(second.cached).not.toBe(true);
        expect(second.requestId).not.toBe(first.requestId);
      });
    } finally {
      await t.close();
    }
  });
});

describe('management CLI project export and import', () => {
  it('round-trips a project export through POST /api/import', async () => {
    const source = await createTestApp();
    const target = await createTestApp();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jasmine-cli-'));
    const cli = (base: string, ...args: string[]) =>
      run(process.execPath, ['sdk/cli.mjs', ...args], {
        cwd: path.resolve('.'),
        timeout: 20000,
        env: { ...process.env, JASMINE_ENDPOINT: base, JASMINE_CLI_CONFIG: path.join(dir, 'profile.json'), JASMINE_API_KEY: '', JASMINE_PROJECT_ID: '' },
      });
    try {
      await source.app.workspace.save('exported', 'Exported flow', {
        nodes: [{ id: 't', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } }],
        edges: [],
      });
      const file = path.join(dir, 'project.json');
      await withHttp(source.app, async (base) => {
        const { stdout } = await cli(base, 'project', 'export', '--output', file);
        expect(JSON.parse(stdout)).toMatchObject({ saved: file, flows: 1 });
      });
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ format: 'jasmine-project', version: 1 });
      await withHttp(target.app, async (base) => {
        const { stdout } = await cli(base, 'project', 'import', file);
        expect(JSON.parse(stdout).imported.map((f: { id: string }) => f.id)).toEqual(['exported']);
        await writeFile(path.join(dir, 'other.json'), JSON.stringify({ nodes: [] }));
        const failed = await cli(base, 'project', 'import', path.join(dir, 'other.json')).catch((e) => e);
        expect(failed.code).toBe(1);
        expect(failed.stderr).toContain('Not a Jasmine project export');
      });
      expect(target.app.workspace.get('exported')?.name).toBe('Exported flow');
    } finally {
      await source.close();
      await target.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
