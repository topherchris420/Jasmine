/// <reference lib="dom" />
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(), catalog: vi.fn() }));
vi.mock('../public/js/api.js', () => ({ api: mocked, catalog: mocked.catalog }));

const catalog = [
  {
    type: 'graphqlNode',
    kind: 'trigger',
    label: 'API Request',
    category: 'trigger',
    icon: 'api',
    description: 'API input',
    fields: [],
    outputs: [],
    defaults: {},
  },
  {
    type: 'graphqlResponseNode',
    kind: 'response',
    label: 'API Response',
    category: 'response',
    icon: 'api',
    description: 'API output',
    fields: [],
    outputs: [],
    defaults: {},
  },
];
const definition = {
  nodes: [
    {
      id: 't',
      type: 'triggerNode',
      position: { x: 0, y: 0 },
      data: { nodeId: 'graphqlNode', trigger: true, values: {} },
    },
    {
      id: 'r',
      type: 'responseNode',
      position: { x: 0, y: 200 },
      data: { nodeId: 'graphqlResponseNode', values: { outputMapping: { ok: true } } },
    },
  ],
  edges: [{ id: 'e', source: 't', target: 'r' }],
};
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<main id="app"></main>';
  mocked.catalog.mockResolvedValue({ list: catalog, byType: new Map(catalog.map((n) => [n.type, n])) });
  mocked.get.mockImplementation(async (path: string) =>
    path === '/api/flows'
      ? []
      : { id: 'example', name: 'Example', revision: 1, definition, summary: { deployedVersion: null } },
  );
});

describe('Studio interaction contracts (DOM simulation)', () => {
  it('opens the local assistant, shows advice, and requires a validated proposal before draft application', async () => {
    mocked.post.mockImplementation(async (path: string) =>
      path.endsWith('/apply')
        ? { revision: 2, definition }
        : {
            text: 'The flow connects API input to its response.',
            definition,
            expectedRevision: 1,
            validation: { ok: true, diagnostics: [] },
          },
    );
    const modulePath = '../public/js/pages/builder.js';
    const { render } = await import(/* @vite-ignore */ modulePath);
    const container = document.getElementById('app')!;
    const cleanup = await render(container, { id: 'example' }, { navigate: () => {} });
    try {
      expect((container.querySelector('.builder-name') as HTMLInputElement).value).toBe('Example');
      button('Assistant').click();
      const textarea = document.querySelector('textarea')!;
      textarea.value = 'Explain @t';
      textarea.dispatchEvent(new Event('input'));
      button('Ask').click();
      await vi.waitFor(() => expect(container.textContent).toContain('The flow connects API input'));
      button('Propose changes').click();
      await vi.waitFor(() => expect(container.textContent).toContain('Validated draft proposal'));
      button('Apply to draft').click();
      await vi.waitFor(() =>
        expect(mocked.post).toHaveBeenCalledWith('/api/flows/example/assistant/apply', {
          definition,
          expectedRevision: 1,
        }),
      );
    } finally {
      if (typeof cleanup === 'function') cleanup();
    }
  });
  it('acknowledges a monitoring alert through its real UI control', async () => {
    mocked.get.mockImplementation(async (path: string) =>
      path === '/api/flows'
        ? []
        : {
            rules: [],
            events: [
              {
                id: 'event',
                ruleName: 'Slow flow',
                runId: 'run',
                flowId: 'f',
                kind: 'latency',
                value: 2000,
                createdAt: new Date().toISOString(),
                acknowledgedAt: null,
              },
            ],
          },
    );
    mocked.post.mockResolvedValue({ acknowledged: true });
    const modulePath = '../public/js/pages/alerts.js';
    const { render } = await import(/* @vite-ignore */ modulePath);
    await render(document.getElementById('app'), {}, { navigate: () => {} });
    button('Acknowledge').click();
    await vi.waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/api/alerts/event/acknowledge'));
  });
});
