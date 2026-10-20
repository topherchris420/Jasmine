/// <reference lib="dom" />
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDENTITY } from '../src/service/identity.ts';
const mocked = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('../public/js/api.js', () => ({ api: mocked }));

const pack = (id: string, title: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, title, description: `${title} description`, caveats: [`${title} caveat`], license: 'Apache-2.0', notice: 'See NOTICES.', origin: 'bundled',
  sources: [{ repository: 'topherchris420/lop-nur-twin', url: 'https://github.com/topherchris420/lop-nur-twin', commit: 'b'.repeat(40), paths: [], license: 'Apache-2.0' }],
  documents: 33, characters: 1000, contentSha256: 'c'.repeat(64), collection: 'jasmine-knowledge', status, installed: null, job: null, ...extra,
});

function self(reachable?: boolean) {
  return {
    detail: 'state', generatedAt: new Date().toISOString(), identity: IDENTITY, awareness: IDENTITY.awareness, summary: 'I am Jasmine…',
    abilities: { steps: 70, byCategory: { app: 26, rag: 10, trigger: 9, ai: 9 }, triggers: [], applications: ['Chat assistant'], templates: 13, integrations: [] },
    models: { answering: { connection: 'lm', name: 'LM Studio', model: 'qwen3.5-4b', local: true }, demoOnly: false, probed: reachable !== undefined,
      connections: [{ connection: 'lm', name: 'LM Studio', kind: 'openai', local: true, chatModel: 'qwen3.5-4b', embeddingModel: 'nomic-embed-text', defaultChat: true, defaultEmbedding: true, ...(reachable === undefined ? {} : { reachable, error: null }) }] },
    knowledge: { packs: [], collections: [] },
    runtime: { version: '1.2.0', node: '24.0.0', platform: 'linux/x64', startedAt: new Date().toISOString(), uptimeSeconds: 5, hosted: false, persistent: true, load: { active: 0, queued: 0 }, workflows: 2, deployed: 1 },
    experience: { since: '', runs: 12, succeeded: 11, failed: 1, successRate: 11 / 12, p50Ms: 4100, p95Ms: 9000, tokens: 5000, modelCalls: 12, topErrors: [], models: [], feedback: { count: 0, rated: 0, avgRating: null } },
    limits: ['My planner is pattern-based: I build from my catalog of executable steps, not open-ended designs.'],
  };
}

const pageModule = '../public/js/pages/jasmine.js';
let packs: ReturnType<typeof pack>[];
let collections: { name: string }[];

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<main id="app"></main>';
  packs = [pack('jasmine-docs', 'Jasmine’s own documentation', 'available'), pack('rain-lab', 'R.A.I.N. Lab', 'available'), pack('openai-math', 'openai/math catalogue', 'installed', { installed: { collection: 'jasmine-knowledge', present: 390, chunks: 1483, installedAt: new Date().toISOString(), embeddingModel: 'nomic-embed-text', contentSha256: 'c'.repeat(64), documents: 390 } })];
  collections = [];
  mocked.get.mockImplementation(async (path: string) => {
    if (path === '/api/self?detail=state') return self();
    if (path === '/api/self?detail=state&probe=true') return self(true);
    if (path === '/api/knowledge/packs') return { packs, problems: [] };
    if (path === '/api/collections?kind=knowledge') return collections;
    if (path === '/api/models') return [
      { connection: 'builtin', name: 'Built-in lexical embeddings', kind: 'builtin', ok: true, models: [{ id: 'jasmine-lexical-384', kind: 'embedding' }] },
      { connection: 'lm', name: 'LM Studio', kind: 'openai', ok: true, models: [{ id: 'qwen3.5-4b', kind: 'chat' }, { id: 'nomic-embed-text', kind: 'embedding' }] },
    ];
    throw new Error(`unexpected GET ${path}`);
  });
  mocked.post.mockImplementation(async () => ({}));
  mocked.del.mockImplementation(async () => ({ removed: 390, collectionDeleted: false }));
});

async function open() {
  const { render } = await import(/* @vite-ignore */ pageModule);
  const container = document.getElementById('app')!;
  const cleanup = await render(container, {}, { navigate: vi.fn(), query: new URLSearchParams() });
  return { container, cleanup: typeof cleanup === 'function' ? cleanup : () => {} };
}

describe('About Jasmine page (DOM simulation)', () => {
  it('shows who she is, how she is doing, and fills in reachability once probed', async () => {
    const { container, cleanup } = await open();
    try {
      expect(container.querySelector('h1')!.textContent).toBe('About Jasmine');
      expect(container.textContent).toContain('I am Jasmine.');
      expect(container.textContent).toContain('My question is always “Can we actually build this?”');
      expect(container.querySelector('a[href$="JASMINE_SOUL.md"]')).not.toBeNull();
      expect(container.querySelector('.stats')!.textContent).toContain('92% succeeded');
      expect(container.querySelector('.stats')!.textContent).toContain('qwen3.5-4b');
      expect(container.querySelector('.stats')!.textContent).toContain('1 of 3');
      await vi.waitFor(() => expect(container.textContent).toContain('on this machine · reachable'));
      expect(container.querySelector('#knowledge')!.textContent).toContain('Installed');
      expect(container.textContent).toContain(IDENTITY.awareness);
    } finally {
      cleanup();
    }
  });

  it('installs every missing pack after one embedding choice, preferring a learned model', async () => {
    const { container, cleanup } = await open();
    try {
      [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Install all'))!.click();
      await vi.waitFor(() => expect(document.querySelector('dialog.modal')).not.toBeNull());
      const dialog = document.querySelector('dialog.modal')!;
      expect(dialog.textContent).toContain('66 documents go into the “jasmine-knowledge” knowledge collection');
      expect((dialog.querySelector('select') as HTMLSelectElement).value).toBe('lm::nomic-embed-text');
      [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Install')!.click();
      await vi.waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
      expect(mocked.post.mock.calls).toEqual([
        ['/api/knowledge/packs/jasmine-docs/install', { embeddingConnection: 'lm', embeddingModel: 'nomic-embed-text' }],
        ['/api/knowledge/packs/rain-lab/install', {}],
      ]);
    } finally {
      cleanup();
    }
  });

  it('asks before removing a pack', async () => {
    const { container, cleanup } = await open();
    try {
      (container.querySelector('button[title="Remove openai/math catalogue"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(document.querySelector('dialog.modal')?.textContent).toContain('Remove openai/math catalogue? Its 390 documents leave “jasmine-knowledge”'));
      expect(mocked.del).not.toHaveBeenCalled();
      [...document.querySelectorAll<HTMLButtonElement>('dialog.modal button')].find((b) => b.textContent?.trim() === 'Remove')!.click();
      await vi.waitFor(() => expect(mocked.del).toHaveBeenCalledWith('/api/knowledge/packs/openai-math'));
    } finally {
      cleanup();
    }
  });
});
