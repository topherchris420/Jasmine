// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(), stream: vi.fn(), catalog: vi.fn() }));
vi.mock('../public/js/api.js', () => ({ api: mocked, catalog: mocked.catalog }));
const { render: setup } = await import('../public/js/pages/setup.js');
const { render: templates } = await import('../public/js/pages/templates.js');
const { composer } = await import('../public/js/planner.js');
const button = text => [...document.querySelectorAll('button')].find(el => el.textContent.includes(text));
const routes = (table) => async (path) => { for (const [prefix, value] of table) if (path === prefix || path.startsWith(prefix)) return typeof value === 'function' ? value(path) : value; throw new Error(`unexpected GET ${path}`); };
const query = (q) => ({ query: new URLSearchParams(q) });
beforeEach(() => {
  document.body.innerHTML = '<main></main>';
  vi.clearAllMocks();
  sessionStorage.clear();
  mocked.catalog.mockResolvedValue({ list: [], byType: new Map() });
});

describe('First-time experience: three ways in', () => {
  it('offers Explore, Connect and Build as the first choices', async () => {
    mocked.get.mockImplementation(routes([['/api/setup', { project: { name: 'My workspace' }, connections: 0 }]]));
    await setup(document.querySelector('main'), {}, { navigate: vi.fn(), ...query('') });
    expect([...document.querySelectorAll('.path-card h2')].map(e => e.textContent)).toEqual(['Explore Jasmine', 'Connect my AI', 'Build something']);
  });

  it('runs a real model-free workflow and shows each step finish, without configuring a model', async () => {
    mocked.get.mockImplementation(routes([
      ['/api/setup', { project: { name: 'My workspace' }, connections: 0 }],
      ['/api/flows', []],
      ['/api/runs/run-1', { status: 'success', inputTokens: 0, outputTokens: 0, llmCalls: 0, models: [], nodes: [{ nodeId: 'request', status: 'success', durationMs: 1 }, { nodeId: 'response', status: 'success', durationMs: 2 }] }],
    ]));
    mocked.post.mockImplementation(async (path) => path === '/api/flows' ? { id: 'your-first-api' } : { requestId: 'run-1', status: 'in-progress' });
    mocked.stream.mockImplementation((_path, _body, onEvent) => {
      setTimeout(() => {
        onEvent('trace', { type: 'node.start', nodeId: 'request' });
        onEvent('trace', { type: 'node.success', nodeId: 'request', durationMs: 1 });
        onEvent('trace', { type: 'node.start', nodeId: 'response' });
        onEvent('trace', { type: 'node.success', nodeId: 'response', durationMs: 2 });
        onEvent('done', { status: 'success', output: { message: 'Hello, Jasmine', ready: true }, timeTakenInSeconds: 0.004 });
      });
      return () => {};
    });
    const navigate = vi.fn();
    await setup(document.querySelector('main'), {}, { navigate, ...query('path=explore') });
    button('Create and run it').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('That was a real run.'));
    expect(document.body.textContent).toContain('No AI model was involved');
    expect(mocked.post).toHaveBeenCalledWith('/api/flows', { templateId: 'first-workflow' });
    expect(mocked.post).toHaveBeenCalledWith('/api/flows/your-first-api/test', { payload: { message: 'Hello, Jasmine' } });
    expect(document.querySelectorAll('.run-step.success')).toHaveLength(2);
    expect(document.querySelector('.text-output, .json-panel')).not.toBeNull();
    button('Open in the builder').click();
    expect(navigate).toHaveBeenCalledWith('/flows/your-first-api');
  });

  it('enables explicitly labeled demo responses without a provider key', async () => {
    mocked.get.mockImplementation(routes([['/api/setup', { project: { name: 'Workspace' }, connections: 0 }], ['/api/hosting', { mode: 'direct' }]]));
    mocked.post.mockImplementation(async () => ({ id: 'demo', name: 'Demo responses', kind: 'mock' }));
    mocked.put.mockResolvedValue({});
    await setup(document.querySelector('main'), {}, { navigate: vi.fn(), ...query('path=connect') });
    button('Demo responses').click();
    button('Enable demo responses').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('no AI model runs'));
    expect(mocked.post).toHaveBeenCalledWith('/api/models/connections', { name: 'Demo responses', kind: 'mock' });
    expect(mocked.put).toHaveBeenCalledWith('/api/models/defaults', { chat: 'demo' });
  });

  it('tests a hosted endpoint from the runtime before saving, and keeps the chosen chat model', async () => {
    mocked.get.mockImplementation(routes([['/api/setup', { project: { name: 'Workspace' }, connections: 0 }], ['/api/hosting', { mode: 'vercel-gateway' }]]));
    const diagnosis = { ok: true, kind: 'openai', baseUrl: 'https://provider.example/v1', location: { id: 'internet', label: 'A server on the internet', detail: 'HTTPS' }, latencyMs: 40,
      checks: [{ id: 'reach', label: 'Server responds', status: 'pass', detail: 'ok' }], models: [{ id: 'chat-v1', kind: 'chat', capabilities: ['chat'] }, { id: 'embed-v1', kind: 'embedding', capabilities: ['embedding'] }],
      capabilities: { chat: true, embedding: true, vision: false }, suggested: { chatModel: 'chat-v1', embeddingModel: 'embed-v1' }, hints: [] };
    mocked.post.mockImplementation(async (path) => path === '/api/models/diagnose' ? diagnosis : { id: 'my-model-server', name: 'My model server', chatModel: 'chat-v1', embeddingModel: 'embed-v1' });
    mocked.put.mockResolvedValue({});
    await setup(document.querySelector('main'), {}, { navigate: vi.fn(), ...query('path=connect') });
    expect(document.body.textContent).toContain('Jasmine’s engine runs on a server');
    button('Other OpenAI-compatible').click();
    const url = document.querySelector('input[type=url]'); url.value = 'https://provider.example/v1'; url.dispatchEvent(new Event('input'));
    const key = document.querySelector('input[type=password]'); key.value = 'sk-provider-key'; key.dispatchEvent(new Event('input'));
    button('Test connection').click();
    await vi.waitFor(() => expect(button('Save and use this connection')).toBeTruthy());
    expect(mocked.post).toHaveBeenCalledWith('/api/models/diagnose', { kind: 'openai', baseUrl: 'https://provider.example/v1', apiKey: 'sk-provider-key' });
    expect(mocked.post).not.toHaveBeenCalledWith('/api/models/connections', expect.anything());
    button('Save and use this connection').click();
    await vi.waitFor(() => expect(mocked.put).toHaveBeenCalledWith('/api/models/defaults', { chat: 'my-model-server', embedding: 'my-model-server' }));
    expect(mocked.post).toHaveBeenCalledWith('/api/models/connections', { name: 'My model server', kind: 'openai', baseUrl: 'https://provider.example/v1', chatModel: 'chat-v1', embeddingModel: 'embed-v1', apiKey: 'sk-provider-key' });
    expect(document.body.textContent).toContain('My model server is connected');
  });

  it('explains a failed connection test with recovery steps instead of saving silently', async () => {
    mocked.get.mockImplementation(routes([['/api/setup', { project: { name: 'Workspace' }, connections: 0 }], ['/api/hosting', { mode: 'direct' }]]));
    mocked.post.mockResolvedValue({ ok: false, kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', location: { id: 'runtime', label: 'The Jasmine runtime’s own machine', detail: '' }, latencyMs: null,
      checks: [{ id: 'reach', label: 'Server responds', status: 'fail', detail: 'Nothing answered' }], models: [], capabilities: {}, suggested: {}, hints: [{ title: 'Start Ollama', steps: ['Open the Ollama app, or run “ollama serve” in a terminal.'] }] });
    await setup(document.querySelector('main'), {}, { navigate: vi.fn(), ...query('path=connect&kind=ollama') });
    button('Test connection').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Start Ollama'));
    expect(document.body.textContent).toContain('ollama serve');
    expect(button('Save it anyway')).toBeTruthy();
    expect(mocked.post).toHaveBeenCalledTimes(1);
  });
});

describe('Describe what you want to build', () => {
  const plan = {
    description: 'Make an API that classifies incoming customer feedback.', name: 'Customer feedback classifier', summary: 'An API that sorts incoming customer feedback.',
    intent: { id: 'classify', label: 'Sort incoming text into categories', confidence: 'high', signals: ['an API trigger'] }, alternatives: [{ id: 'extract', label: 'Pull structured fields out of text' }],
    trigger: { type: 'graphqlNode', label: 'API endpoint', howToUse: 'Send {"feedback": …}' },
    steps: [{ id: 'trigger', type: 'graphqlNode', name: 'Receive the feedback', summary: 'Starts the workflow.', role: 'Accepts JSON.' }, { id: 'classify', type: 'agentClassifierNode', name: 'Choose a category', summary: 'Sorts input.', role: 'Uses your model.' }],
    assumptions: ['Categories: Praise, Other.'], readiness: { ready: false, missing: 1, warnings: 0, requirements: [{ id: 'model:none', kind: 'model', status: 'missing', title: 'Connect an AI model', detail: 'No model yet.', nodeIds: ['classify'], action: { label: 'Connect a model', href: '/setup?path=connect' } }] },
    validation: { ok: true, diagnostics: [] }, definition: { nodes: [{ id: 'trigger' }], edges: [] }, tailoring: { requested: false, used: false, note: 'Built from Jasmine’s workflow patterns.' },
  };

  it('proposes a reviewed workflow and creates a draft only after explicit approval', async () => {
    mocked.post.mockImplementation(async (path) => path === '/api/plan' ? plan : { id: 'customer-feedback-classifier' });
    const navigate = vi.fn();
    document.querySelector('main').append(composer({ navigate }));
    button('Make an API that classifies').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Proposed workflow'));
    expect(mocked.post).toHaveBeenCalledWith('/api/plan', { description: plan.description }, expect.anything());
    expect(document.querySelectorAll('.plan-step')).toHaveLength(2);
    expect(document.body.textContent).toContain('1 to set up');
    expect(document.body.textContent).toContain('Connect an AI model');
    expect(document.body.textContent).toContain('Nothing runs, deploys or becomes public');
    expect(mocked.post).not.toHaveBeenCalledWith('/api/flows', expect.anything());
    const name = document.querySelector('.plan-name'); name.value = 'Feedback sorter'; name.dispatchEvent(new Event('input'));
    button('Create workflow').click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/flows/customer-feedback-classifier?from=plan'));
    expect(mocked.post).toHaveBeenCalledWith('/api/flows', { name: 'Feedback sorter', definition: plan.definition });
  });

  it('re-plans with a different interpretation on request', async () => {
    mocked.post.mockResolvedValue(plan);
    document.querySelector('main').append(composer({ navigate: vi.fn() }));
    const area = document.querySelector('textarea'); area.value = plan.description;
    button('Plan my workflow').click();
    await vi.waitFor(() => expect(button('Pull structured fields out of text')).toBeTruthy());
    button('Pull structured fields out of text').click();
    await vi.waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/api/plan', { description: plan.description, intent: 'extract' }, expect.anything()));
  });
});

describe('Templates gallery', () => {
  it('filters templates, shows what each needs, and creates the selected real flow', async () => {
    mocked.get.mockResolvedValue([
      { id: 'first-workflow', name: 'Your First API', description: 'Returns JSON', useCase: 'Ship a real endpoint', input: '{"message": "Hi"}', output: '{"ready": true}', category: 'Getting started', prerequisites: { modelFree: true, items: [] }, definition: { nodes: [{ data: { nodeId: 'graphqlNode' } }] } },
      { id: 'chat', name: 'Chat', description: 'Ask your model', category: 'Chat', prerequisites: { modelFree: false, items: [{ kind: 'model', label: 'A chat model' }] }, definition: { nodes: [{ data: { nodeId: 'LLMNode' } }] } },
    ]);
    mocked.post.mockResolvedValue({ id: 'selected' });
    const navigate = vi.fn();
    await templates(document.querySelector('main'), {}, { navigate });
    expect(document.querySelectorAll('.template-grid .card')).toHaveLength(2);
    expect(document.body.textContent).toContain('Nothing to set up');
    expect(document.body.textContent).toContain('A chat model');
    button('Works without a model').click();
    expect(document.querySelectorAll('.template-grid .card')).toHaveLength(1);
    button('Works without a model').click();
    const search = document.querySelector('input'); search.value = 'JSON'; search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.template-grid .card')).toHaveLength(1);
    button('Use template').click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/flows/selected?from=template'));
    expect(mocked.post).toHaveBeenCalledWith('/api/flows', { templateId: 'first-workflow' });
  });
});
