import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { EngineError } from '../src/errors.ts';
import { lexicalEmbedding, MockLLMProvider, type LLMRequest, type MockReply } from '../src/llm/providers.ts';
import { createTestApp } from './helpers.ts';

const trigger = { id: 'triggerNode_1', type: 'triggerNode', data: { nodeId: 'graphqlNode', trigger: true, values: {} } };
const respond = (mapping: string, id = 'responseNode_1') => ({ id, type: 'responseNode', data: { nodeId: 'graphqlResponseNode', values: { outputMapping: mapping } } });
const chain = (...ids: string[]) => ids.slice(1).map((id, i) => ({ source: ids[i]!, target: id }));
const lastContent = (req: LLMRequest) => req.messages.at(-1)!.content;

describe('Generate Text with tools', () => {
  it('runs a local tool-calling loop over knowledge-base, code and flow tools', async () => {
    const llm = new MockLLMProvider({
      respond: (req, call): string | MockReply => {
        if (call === 1) return { toolCalls: [{ id: 'a', name: 'search_kb', arguments: { query: 'refund window' } }, { id: 'b', name: 'add', arguments: { x: 2, y: 3 } }] };
        if (call === 2) return { toolCalls: [{ id: 'c', name: 'shout', arguments: { text: 'hi' } }] };
        if (req.tools?.length === undefined) return 'should not happen';
        return `final: ${req.messages.filter((m) => m.role === 'tool').map((m) => m.content).join(' | ')}`;
      },
    });
    const t = await createTestApp({ llm });
    try {
      const { app } = t;
      app.vectors.createCollection({ name: 'kb', embeddingConnection: 'builtin' });
      app.vectors.upsert('kb', [{ id: 'r', text: 'Refunds are accepted within a 14 day window.', metadata: { title: 'Refunds' }, vector: lexicalEmbedding('Refunds are accepted within a 14 day window.') }]);
      await app.deployments.deploy('shout', {
        nodes: [trigger, { id: 'c', data: { nodeId: 'codeNode', values: { code: 'output = { loud: String({{triggerNode_1.output.text}}).toUpperCase() };' } } }, respond('{"loud": "{{c.output.loud}}"}')],
        edges: chain('triggerNode_1', 'c', 'responseNode_1'),
      });
      await app.deployments.deploy('agent', {
        nodes: [
          trigger,
          { id: 'LLMNode_1', data: { nodeId: 'LLMNode', values: {
            prompts: [{ role: 'user', content: '{{triggerNode_1.output.q}}' }],
            tools: [
              { type: 'vectorSearch', name: 'search_kb', vectorDB: 'kb' },
              { type: 'code', name: 'add', description: 'Adds numbers', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } }, code: 'return { sum: args.x + args.y };' },
              { type: 'flow', name: 'shout', flowId: 'shout' },
              'f1d2c3-imported-tool-uuid',
            ],
          } } },
          respond('{"answer": "{{LLMNode_1.output.generatedResponse}}", "calls": "{{LLMNode_1.output.toolCalls[:].name}}"}'),
        ],
        edges: chain('triggerNode_1', 'LLMNode_1', 'responseNode_1'),
      });
      const res = await app.runs.executeWorkflow('agent', { q: 'What is the refund window?' });
      expect(res.error).toBeUndefined();
      expect(res.output).toMatchObject({ calls: ['search_kb', 'add', 'shout'] });
      const answer = (res.output as { answer: string }).answer;
      expect(answer).toContain('14 day window');
      expect(answer).toContain('{"sum":5}');
      expect(answer).toContain('{"loud":"HI"}');
      expect(llm.requests[0]!.tools!.map((x) => x.name)).toEqual(['search_kb', 'add', 'shout']);
      expect(res.usage?.llmCalls).toBe(3);
      expect(app.runStore.list({ flowId: 'shout' }).runs[0]).toMatchObject({ source: 'flow', status: 'success' });
    } finally {
      await t.close();
    }
  });

  it('falls back to the next model config when the first fails', async () => {
    const llm = new MockLLMProvider({ fail: (req) => (req.model === 'broken' ? new EngineError('PROVIDER', 'model crashed', { retryable: true }) : undefined), respond: (req) => `answered by ${req.model}` });
    // An explicitly chosen connection gets the model it names verbatim, so "broken" reaches the server and fails.
    const t = await createTestApp({ llm });
    try {
      await t.app.deployments.deploy('fb', {
        nodes: [trigger, { id: 'l', data: { nodeId: 'LLMNode', values: { prompts: [{ role: 'user', content: 'hi' }], generativeModelName: [{ connection: 'mock', model_name: 'broken' }, { connection: 'mock', model_name: 'backup' }] } } }, respond('{"a": "{{l.output.generatedResponse}}"}')],
        edges: chain('triggerNode_1', 'l', 'responseNode_1'),
      });
      expect((await t.app.runs.executeWorkflow('fb', {})).output).toEqual({ a: 'answered by backup' });
      expect(llm.requests.map((r) => r.model)).toEqual(['broken', 'backup']);
    } finally {
      await t.close();
    }
  });

  it('sends image attachments to vision models as data URLs', async () => {
    const llm = new MockLLMProvider({ respond: (req) => `images: ${req.messages.at(-1)!.images?.length ?? 0}` });
    const t = await createTestApp({ llm });
    try {
      const png = `data:image/png;base64,${Buffer.from('fake').toString('base64')}`;
      const upload = t.app.files.save(Buffer.from('jpeg-bytes'), 'photo.jpg', 'image/jpeg');
      await t.app.deployments.deploy('vision', {
        nodes: [trigger, { id: 'v', data: { nodeId: 'multiModalLLMNode', values: { prompts: [{ role: 'user', content: 'Describe' }], attachments: '{{triggerNode_1.output.images}}' } } }, respond('{"a": "{{v.output.generatedResponse}}"}')],
        edges: chain('triggerNode_1', 'v', 'responseNode_1'),
      });
      expect((await t.app.runs.executeWorkflow('vision', { images: [png, upload.url] })).output).toEqual({ a: 'images: 2' });
      expect(llm.requests[0]!.messages.at(-1)!.images![1]).toBe(`data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`);
    } finally {
      await t.close();
    }
  });
});

describe('Classifier and Supervisor agents', () => {
  it('routes with the classifier and skips the other branches', async () => {
    const llm = new MockLLMProvider({ respond: (req) => (req.jsonSchema ? JSON.stringify({ class: /invoice/.test(lastContent(req)) ? 'Billing' : 'Other' }) : `reply to ${lastContent(req)}`) });
    const t = await createTestApp({ llm });
    try {
      const template = (await t.app.templates()).find((x) => x.id === 'support-router')!;
      await t.app.workspace.save('router', 'Router', template.definition);
      await t.app.deployFlow('router');
      const billing = await t.app.runs.executeWorkflow('router', { message: 'My invoice is wrong' });
      expect(billing.output).toEqual({ category: 'Billing', reply: 'reply to My invoice is wrong' });
      expect(billing.nodes!.filter((n) => n.statusCode === 304).map((n) => n.nodeId).sort()).toEqual(['LLMNode_other', 'LLMNode_technical', 'response_other', 'response_technical']);
      expect((await t.app.runs.executeWorkflow('router', { message: 'hello' })).output).toMatchObject({ category: 'Other' });
    } finally {
      await t.close();
    }
  });

  it('loops a supervisor over sub-agent branches until it finishes (Lamatic agentNode export)', async () => {
    let turn = 0;
    const llm = new MockLLMProvider({
      respond: (req) => {
        if (req.jsonSchema && /supervisor/.test(req.messages[0]!.content)) {
          turn++;
          if (turn === 1) return JSON.stringify({ next: 'Researcher', topic: 'tides' });
          if (turn === 2) return JSON.stringify({ next: 'Writer', notes: 'moon gravity' });
          return JSON.stringify({ next: 'FINISH', final_answer: 'Tides come from the moon.' });
        }
        return `${lastContent(req)}!`;
      },
    });
    const t = await createTestApp({ llm });
    try {
      const flow = {
        nodes: [
          trigger,
          { id: 'agentNode_1', type: 'agentNode', data: { nodeId: 'agentNode', values: {
            prompts: [{ role: 'user', content: '{{triggerNode_1.output.q}}' }], connectedTo: 'agentLoopEndNode_1', maxIterations: 5,
            agents: [{ name: 'Researcher', description: 'Researches', schema: '{"topic":"string"}' }, { name: 'Writer', description: 'Writes', schema: '{"notes":"string"}' }],
          } } },
          { id: 'LLMNode_r', data: { nodeId: 'LLMNode', values: { prompts: [{ role: 'user', content: 'research {{agentNode_1.output.topic}}' }] } } },
          { id: 'LLMNode_w', data: { nodeId: 'LLMNode', values: { prompts: [{ role: 'user', content: 'write {{agentNode_1.output.notes}}' }] } } },
          { id: 'agentLoopEndNode_1', type: 'agentLoopEndNode', data: { nodeId: 'agentLoopEndNode', values: { connectedTo: 'agentNode_1' } } },
          respond('{"answer": "{{agentLoopEndNode_1.output.finalResponse}}", "turns": "{{agentLoopEndNode_1.output.history[:].agent}}"}', 'responseNode_triggerNode_1'),
        ],
        edges: [
          { id: 'e0', source: 'triggerNode_1', target: 'agentNode_1', type: 'defaultEdge' },
          { id: 'e1', source: 'agentNode_1', target: 'LLMNode_r', type: 'conditionEdge', data: { condition: 'Researcher' } },
          { id: 'e2', source: 'agentNode_1', target: 'LLMNode_w', type: 'conditionEdge', data: { condition: 'Writer' } },
          { id: 'e3', source: 'LLMNode_r', target: 'agentLoopEndNode_1', type: 'defaultEdge' },
          { id: 'e4', source: 'LLMNode_w', target: 'agentLoopEndNode_1', type: 'defaultEdge' },
          { id: 'e5', source: 'agentNode_1', target: 'agentLoopEndNode_1', type: 'agentLoopEdge' },
          { id: 'e6', source: 'agentLoopEndNode_1', target: 'agentNode_1', type: 'agentLoopEdge' },
          { id: 'e7', source: 'agentLoopEndNode_1', target: 'responseNode_triggerNode_1', type: 'defaultEdge' },
          { id: 'response-x', source: 'triggerNode_1', target: 'responseNode_triggerNode_1', type: 'responseEdge' },
        ],
      };
      await t.app.deployments.deploy('super', flow);
      const res = await t.app.runs.executeWorkflow('super', { q: 'Why are there tides?' });
      expect(res.error).toBeUndefined();
      expect(res.output).toEqual({ answer: 'Tides come from the moon.', turns: ['Researcher', 'Writer'] });
      const prompts = llm.requests.filter((r) => !r.jsonSchema).map(lastContent);
      expect(prompts).toEqual(['research tides', 'write moon gravity']);
      const supervisorTurn3 = llm.requests.filter((r) => r.jsonSchema)[2]!;
      expect(supervisorTurn3.messages[0]!.content).toContain('Writer was given {"notes":"moon gravity"} and returned "write moon gravity!"');
    } finally {
      await t.close();
    }
  });
});

describe('MCP integration', () => {
  it('lets a local model call the tools of a Streamable HTTP MCP server', async () => {
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: { city?: string } } };
        calls.push(msg.method);
        if (req.headers.authorization !== 'Bearer mcp-token') {
          res.writeHead(401).end();
          return;
        }
        if (msg.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'weather' } }
          : msg.method === 'tools/list' ? { tools: [{ name: 'get_weather', description: 'Weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }, { name: 'unused', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: `Sunny in ${msg.params?.arguments?.city}` }] };
        if (msg.method === 'tools/call') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
          res.end(`: hello\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
        } else {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        }
      });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const llm = new MockLLMProvider({ respond: (req, call) => (call === 1 ? { toolCalls: [{ id: 'x', name: 'get_weather', arguments: { city: 'Lisbon' } }] } : `It is ${req.messages.at(-1)!.content}`) });
    const t = await createTestApp({ llm });
    try {
      t.app.credentials.upsert({ integration: 'mcp', name: 'weather', data: { url, token: 'mcp-token' } });
      await t.app.deployments.deploy('mcp', {
        nodes: [trigger, { id: 'm', data: { nodeId: 'mcpNode', values: { credentials: 'weather', selectedTools: ['get_weather'], prompts: [{ role: 'user', content: 'Weather in Lisbon?' }] } } }, respond('{"a": "{{m.output.generatedResponse}}"}')],
        edges: chain('triggerNode_1', 'm', 'responseNode_1'),
      });
      const res = await t.app.runs.executeWorkflow('mcp', {});
      expect(res.output).toEqual({ a: 'It is Sunny in Lisbon' });
      expect(llm.requests[0]!.tools!.map((x) => x.name)).toEqual(['get_weather']);
      expect(calls).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    } finally {
      await t.close();
      server.close();
    }
  });
});
