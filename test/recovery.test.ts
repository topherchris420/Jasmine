import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Jasmine } from '../src/app.ts';
import { executePlan } from '../src/runtime/executor.ts';
import { edge, makeServices, newLog, plan, probe, response, testRegistry, trigger } from './helpers.ts';

describe('execution checkpoints', () => {
  it('stops before running a dependent when the checkpoint cannot be persisted', async () => {
    const log = newLog();
    const p = plan(
      [trigger(), probe('action'), response('{}')],
      [edge('trigger', 'action'), edge('action', 'response')],
      testRegistry(log),
    );
    const result = await executePlan(p, {
      payload: {},
      services: makeServices(),
      onCheckpoint: () => {
        throw new Error('checkpoint write failed');
      },
    });
    expect(result.status).toBe('failed');
    expect(log.calls.has('action')).toBe(false);
  });

  it('recovers a killed process and retries without repeating its completed HTTP write', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'jasmine-process-recovery-'));
    let healthy = false,
      first = 0,
      second = 0,
      seen!: () => void;
    const secondSeen = new Promise<void>((resolve) => {
      seen = resolve;
    });
    const server = http
      .createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/first') {
          first++;
          res.end('{"saved":"completed-before-crash"}');
        } else {
          second++;
          seen();
          if (healthy) res.end('{"recovered":true}');
        }
      })
      .listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const config = { dataDir, env: { LLM_PROVIDER: 'mock' }, scheduler: false, probeModels: false, seed: false };
    let app: Jasmine | undefined = await Jasmine.create(config),
      child: ReturnType<typeof spawn> | undefined;
    try {
      await app.deployments.deploy('recovery', {
        nodes: [
          { id: 't', data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
          {
            id: 'first',
            data: {
              nodeId: 'apiNode',
              values: { url: base + '/first', method: 'POST', body: '{"value":"write-once"}' },
            },
          },
          { id: 'second', data: { nodeId: 'apiNode', values: { url: base + '/second', method: 'GET' } } },
          {
            id: 'r',
            data: {
              nodeId: 'graphqlResponseNode',
              values: { outputMapping: { first: '{{first.output}}', second: '{{second.output}}' } },
            },
          },
        ],
        edges: [
          { source: 't', target: 'first' },
          { source: 'first', target: 'second' },
          { source: 'second', target: 'r' },
        ],
      });
      await app.close();
      app = undefined;
      const source = new URL('../src/app.ts', import.meta.url).href;
      child = spawn(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          '--input-type=module',
          '-e',
          `import {Jasmine} from ${JSON.stringify(source)};const app=await Jasmine.create(${JSON.stringify(config)});const accepted=await app.runs.executeWorkflow('recovery',{}, {mode:'async',idempotencyKey:'durable-crash'});console.log(JSON.stringify({requestId:accepted.requestId}));await app.runs.wait(accepted.requestId);await app.close();`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const id = new Promise<string>((resolve, reject) => {
        let output = '';
        child!.stdout!.setEncoding('utf8');
        child!.stdout!.on('data', (chunk) => {
          output += chunk;
          const line = output.split('\n')[0];
          if (line?.trim())
            try {
              resolve(JSON.parse(line).requestId);
            } catch {}
        });
        child!.once('error', reject);
      });
      const timeout = AbortSignal.timeout(15000);
      await Promise.race([
        secondSeen,
        new Promise((_, reject) =>
          timeout.addEventListener('abort', () => reject(new Error('Child did not reach checkpoint')), { once: true }),
        ),
      ]);
      const requestId = await id,
        exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
      child = undefined;
      app = await Jasmine.create(config);
      expect(app.runs.checkStatus(requestId).error?.code).toBe('INTERRUPTED');
      expect(app.runs.trace(requestId).some((e) => e.type === 'node.success' && e.nodeId === 'first')).toBe(true);
      expect(app.runStore.get(requestId)?.nodes).toMatchObject([{ nodeId: 't' }, { nodeId: 'first' }]);
      expect(JSON.stringify(app.db.all('SELECT * FROM execution_state'))).not.toContain('completed-before-crash');
      healthy = true;
      const recovered = await app.runs.retryWorkflow(requestId);
      expect(recovered.status).toBe('success');
      expect(recovered.output).toEqual({ first: { saved: 'completed-before-crash' }, second: { recovered: true } });
      expect(first).toBe(1);
      expect(second).toBe(2);
    } finally {
      if (child) {
        const exit = once(child, 'exit');
        child.kill('SIGKILL');
        await exit;
      }
      await app?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30000);
});
