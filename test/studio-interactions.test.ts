/// <reference lib="dom" />
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(), stream: vi.fn(), catalog: vi.fn() }));
vi.mock('../public/js/api.js', () => ({ api: mocked, catalog: mocked.catalog }));

const catalog = [
  { type: 'graphqlNode', kind: 'trigger', label: 'API Request', category: 'trigger', icon: 'api', description: 'API input', summary: 'Starts the workflow when your app sends a request.', fields: [], outputs: [], defaults: {} },
  { type: 'graphqlResponseNode', kind: 'response', label: 'API Response', category: 'response', icon: 'api', description: 'API output', summary: 'Sends the result back.', fields: [], outputs: [], defaults: {} },
  { type: 'LLMNode', kind: 'action', label: 'Generate Text', category: 'ai', icon: 'agent', description: 'Model', summary: 'Uses your model.', fields: [{ key: 'prompts', label: 'Messages', type: 'prompts', required: true }], outputs: [{ path: 'generatedResponse', type: 'string' }], defaults: {} },
];
const definition = {
  nodes: [
    { id: 't', type: 'triggerNode', position: { x: 0, y: 0 }, data: { nodeId: 'graphqlNode', trigger: true, values: {} } },
    { id: 'r', type: 'responseNode', position: { x: 0, y: 200 }, data: { nodeId: 'graphqlResponseNode', values: { outputMapping: { ok: true } } } },
  ],
  edges: [{ id: 'e', source: 't', target: 'r' }],
};
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
const buttonWith = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
const key = (target: EventTarget, k: string, opts: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
const flow = (def: unknown = definition, extra: Record<string, unknown> = {}) => ({ id: 'example', name: 'Example', revision: 1, definition: def, summary: { deployedVersion: null, lifecycle: { state: 'validated', label: 'Validated', detail: '' } }, ...extra });
const builderModule = '../public/js/pages/builder.js';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = '<main id="app"></main>';
  mocked.catalog.mockResolvedValue({ list: catalog, byType: new Map(catalog.map((n) => [n.type, n])) });
  mocked.get.mockImplementation(async (path: string) => (path === '/api/flows' ? [] : flow()));
  mocked.put.mockImplementation(async (_path: string, body: { definition: unknown }) => ({ revision: 2, updatedAt: new Date().toISOString(), definition: body.definition, summary: flow().summary }));
  mocked.post.mockImplementation(async (path: string) => (path.endsWith('/validate') ? { ok: true, diagnostics: [] } : path === '/api/readiness' ? { ready: true, missing: 0, warnings: 0, requirements: [] } : {}));
});

async function openBuilder(params: Record<string, string> = {}) {
  const { render } = await import(/* @vite-ignore */ builderModule);
  const container = document.getElementById('app')!;
  const navigate = vi.fn();
  const cleanup = await render(container, { id: 'example' }, { navigate, query: new URLSearchParams(params) });
  return { container, navigate, cleanup: typeof cleanup === 'function' ? cleanup : () => {} };
}

describe('Studio interaction contracts (DOM simulation)', () => {
  it('opens the copilot, shows grounded advice, and requires a validated proposal before draft application', async () => {
    mocked.post.mockImplementation(async (path: string) =>
      path.endsWith('/apply')
        ? { revision: 2, definition }
        : path.endsWith('/assistant')
          ? { text: 'The flow connects API input to its response.', definition, expectedRevision: 1, validation: { ok: true, diagnostics: [] }, findings: [] }
          : path.endsWith('/validate') ? { ok: true, diagnostics: [] } : { ready: true, missing: 0, requirements: [] },
    );
    const { container, cleanup } = await openBuilder();
    try {
      expect((container.querySelector('.builder-name') as HTMLInputElement).value).toBe('Example');
      button('Copilot').click();
      const textarea = document.querySelector('.copilot textarea') as HTMLTextAreaElement;
      textarea.value = 'Explain @t';
      textarea.dispatchEvent(new Event('input'));
      button('Ask').click();
      await vi.waitFor(() => expect(container.textContent).toContain('The flow connects API input'));
      button('Propose changes').click();
      await vi.waitFor(() => expect(container.textContent).toContain('Validated draft proposal'));
      expect(mocked.post).not.toHaveBeenCalledWith('/api/flows/example/assistant/apply', expect.anything());
      button('Apply to draft').click();
      await vi.waitFor(() =>
        expect(mocked.post).toHaveBeenCalledWith('/api/flows/example/assistant/apply', expect.objectContaining({ definition, expectedRevision: 1 })),
      );
    } finally {
      cleanup();
    }
  });

  it('runs a quick copilot check without typing and lists its findings', async () => {
    mocked.post.mockImplementation(async (path: string) => path.endsWith('/assistant')
      ? { text: 'I checked validation, model connections, knowledge, credentials and the latest run. 1 thing needs attention:', model: null, findings: [{ status: 'missing', title: 'Connect an AI model', detail: 'No model yet.', nodeIds: ['t'], action: { label: 'Connect a model', href: '/setup?path=connect' } }], validation: { ok: true, diagnostics: [] } }
      : path.endsWith('/validate') ? { ok: true, diagnostics: [] } : { ready: true, missing: 0, requirements: [] });
    const { container, cleanup } = await openBuilder();
    try {
      button('Copilot').click();
      buttonWith('Why isn’t this working?').click();
      await vi.waitFor(() => expect(container.textContent).toContain('Connect an AI model'));
      expect(mocked.post).toHaveBeenCalledWith('/api/flows/example/assistant', { action: 'diagnose', nodeId: null }, expect.anything());
      expect(container.textContent).toContain('Jasmine’s own checks');
    } finally {
      cleanup();
    }
  });

  it('connects steps from the inspector without dragging, and saves the new connection', async () => {
    const def = structuredClone(definition) as typeof definition;
    def.nodes.push({ id: 'llm', type: 'dynamicNode', position: { x: 300, y: 100 }, data: { nodeId: 'LLMNode', values: { prompts: [{ role: 'user', content: '{{t.output}}' }] } } } as never);
    mocked.get.mockImplementation(async (path: string) => (path === '/api/flows' ? [] : flow(def)));
    const { container, cleanup } = await openBuilder();
    try {
      const trigger = container.querySelector('.node[data-id="t"]') as HTMLElement;
      trigger.focus();
      key(trigger, 'Enter');
      await vi.waitFor(() => expect(button('Connections')).toBeTruthy());
      button('Connections').click();
      const picker = [...container.querySelectorAll('select')].find((s) => s.getAttribute('aria-label')?.startsWith('Connect')) as HTMLSelectElement;
      expect([...picker.options].map((o) => o.textContent)).toEqual(['Connect to…', 'Generate Text']);
      picker.value = 'llm';
      picker.dispatchEvent(new Event('change'));
      button('Connect').click();
      key(document.body, 's', { ctrlKey: true });
      await vi.waitFor(() => expect(mocked.put).toHaveBeenCalled());
      const saved = mocked.put.mock.calls.at(-1)![1] as { definition: typeof definition; expectedRevision: number };
      expect(saved.expectedRevision).toBe(1);
      expect(saved.definition.edges.map((e) => `${e.source}->${e.target}`)).toEqual(['t->r', 't->llm']);
    } finally {
      cleanup();
    }
  });

  it('recovers unsaved edits kept in this browser after an interrupted session', async () => {
    const edited = structuredClone(definition) as { nodes: { data: { values: unknown } }[] };
    edited.nodes[1]!.data.values = { outputMapping: { ok: false, restored: true } };
    localStorage.setItem('jasmine.draft.example', JSON.stringify({ baseRevision: 1, at: Date.now() - 60_000, name: 'Example (edited)', definition: edited }));
    const { container, cleanup } = await openBuilder();
    try {
      expect(container.textContent).toContain('Unsaved changes from');
      button('Restore').click();
      key(document.body, 's', { ctrlKey: true });
      await vi.waitFor(() => expect(mocked.put).toHaveBeenCalled());
      const body = mocked.put.mock.calls.at(-1)![1] as { name: string; definition: typeof definition };
      expect(body.name).toBe('Example (edited)');
      expect(body.definition.nodes[1]!.data.values).toEqual({ outputMapping: { ok: false, restored: true } });
      await vi.waitFor(() => expect(localStorage.getItem('jasmine.draft.example')).toBeNull());
    } finally {
      cleanup();
    }
  });

  it('keeps edits and shows an offline state when saving fails, then saves on retry', async () => {
    let attempts = 0;
    mocked.put.mockImplementation(async (_p: string, body: { definition: unknown }) => {
      if (++attempts === 1) throw Object.assign(new Error('Jasmine can’t reach its runtime right now.'), { status: 0 });
      return { revision: 2, updatedAt: new Date().toISOString(), definition: body.definition, summary: flow().summary };
    });
    const { container, cleanup } = await openBuilder();
    try {
      const name = container.querySelector('.builder-name') as HTMLInputElement;
      name.value = 'Renamed';
      name.dispatchEvent(new Event('input'));
      key(document.body, 's', { ctrlKey: true });
      await vi.waitFor(() => expect(container.querySelector('.save-state')!.textContent).toContain('Offline'));
      expect(JSON.parse(localStorage.getItem('jasmine.draft.example')!).name).toBe('Renamed');
      (container.querySelector('.save-state') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(container.querySelector('.save-state')!.textContent).toContain('Saved'));
      expect(attempts).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('shows what will become live and deploys only after confirmation', async () => {
    mocked.post.mockImplementation(async (path: string) => path.endsWith('/validate') ? { ok: true, diagnostics: [] }
      : path === '/api/readiness' ? { ready: true, missing: 0, requirements: [] } : path.endsWith('/deploy') ? { version: 'abcdef1234567890', changed: true } : {});
    const { container, cleanup } = await openBuilder();
    try {
      button('Deploy').click();
      await vi.waitFor(() => expect(document.body.textContent).toContain('What becomes live'));
      expect(document.body.textContent).toContain('/api/v1/flows/example/execute');
      expect(mocked.post).not.toHaveBeenCalledWith('/api/flows/example/deploy', expect.anything());
      button('Deploy version').click();
      await vi.waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/api/flows/example/deploy', {}));
      await vi.waitFor(() => expect(document.body.textContent).toContain('It’s live'));
      void container;
    } finally {
      cleanup();
    }
  });

  it('shows each step’s progress during a test and explains a failure', async () => {
    mocked.post.mockImplementation(async (path: string) => path.endsWith('/test') ? { requestId: 'run-9', status: 'in-progress', diagnostics: [] }
      : path.endsWith('/validate') ? { ok: true, diagnostics: [] } : { ready: true, missing: 0, requirements: [] });
    mocked.get.mockImplementation(async (path: string) => path === '/api/flows' ? [] : path === '/api/runs/run-9'
      ? { status: 'failed', models: [], inputTokens: 0, outputTokens: 0, nodes: [{ nodeId: 't', status: 'success', durationMs: 1 }, { nodeId: 'r', status: 'failed', durationMs: 2, error: { code: 'TEMPLATE_UNRESOLVED', message: 'x' } }],
        explanation: { title: 'A reference points at a value that doesn’t exist', component: 'Step “API Response”', cause: 'misspelled', steps: ['Use the reference picker.'], actions: [], code: 'TEMPLATE_UNRESOLVED', message: 'x' }, nodeExplanations: {} }
      : flow());
    mocked.stream.mockImplementation((_p: string, _b: unknown, onEvent: (e: string, d: unknown) => void) => {
      setTimeout(() => {
        onEvent('trace', { type: 'node.start', nodeId: 't' });
        onEvent('trace', { type: 'node.success', nodeId: 't', durationMs: 1 });
        onEvent('trace', { type: 'node.start', nodeId: 'r' });
        onEvent('trace', { type: 'node.failed', nodeId: 'r', durationMs: 2, error: { code: 'TEMPLATE_UNRESOLVED', message: 'x' } });
        onEvent('done', { status: 'failed', error: { code: 'TEMPLATE_UNRESOLVED', message: 'x', nodeId: 'r' }, timeTakenInSeconds: 0.003 });
      });
      return () => {};
    });
    const { container, cleanup } = await openBuilder({ panel: 'test' });
    try {
      await vi.waitFor(() => expect(button('Run test')).toBeTruthy());
      button('Run test').click();
      await vi.waitFor(() => expect(container.textContent).toContain('A reference points at a value that doesn’t exist'));
      expect(container.querySelectorAll('.run-step.success')).toHaveLength(1);
      expect(container.querySelectorAll('.run-step.failed')).toHaveLength(1);
      expect(container.querySelector('.node[data-id="r"]')!.classList.contains('st-failed')).toBe(true);
      expect(container.textContent).toContain('TEMPLATE_UNRESOLVED: x');
    } finally {
      cleanup();
    }
  });

  it('acknowledges a monitoring alert through its real UI control', async () => {
    mocked.get.mockImplementation(async (path: string) =>
      path === '/api/flows'
        ? []
        : { rules: [], events: [{ id: 'event', ruleName: 'Slow flow', runId: 'run', flowId: 'f', kind: 'latency', value: 2000, createdAt: new Date().toISOString(), acknowledgedAt: null }] },
    );
    mocked.post.mockResolvedValue({ acknowledged: true });
    const modulePath = '../public/js/pages/alerts.js';
    const { render } = await import(/* @vite-ignore */ modulePath);
    await render(document.getElementById('app'), {}, { navigate: () => {} });
    button('Acknowledge').click();
    await vi.waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/api/alerts/event/acknowledge'));
  });
});
