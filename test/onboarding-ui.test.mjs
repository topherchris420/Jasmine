// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('../public/js/api.js', () => ({ api: mocked }));
const { render: setup } = await import('../public/js/pages/setup.js');
const { render: templates } = await import('../public/js/pages/templates.js');
const button = text => [...document.querySelectorAll('button')].find(el => el.textContent.includes(text));
beforeEach(() => { document.body.innerHTML = '<main></main>'; vi.clearAllMocks(); });

describe('First-time builder experience', () => {
  it('lets a user build their first API without configuring a model', async () => {
    mocked.get.mockResolvedValue({ project: { name: 'My workspace' }, connections: 0 });
    mocked.post.mockResolvedValue({ id: 'my-first-api' });
    const navigate = vi.fn();
    await setup(document.querySelector('main'), {}, { navigate });
    button('Create my first API').click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/flows/my-first-api'));
    expect(mocked.post).toHaveBeenCalledExactlyOnceWith('/api/flows', { templateId: 'first-workflow' });
  });
  it('enables explicitly labeled demo responses without a provider key', async () => {
    mocked.get.mockResolvedValue({ project: { name: 'Workspace' }, connections: 0 });
    mocked.post.mockImplementation(async path => path.endsWith('/test') ? { ok: true, models: [] } : { id: 'demo', name: 'Demo responses', kind: 'mock' });
    mocked.put.mockResolvedValue({});
    await setup(document.querySelector('main'), {}, { navigate: vi.fn() });
    const kind = document.querySelector('select'); kind.value = 'mock'; kind.dispatchEvent(new Event('change'));
    button('Enable demo responses').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('no AI model runs'));
    expect(mocked.post).toHaveBeenCalledWith('/api/models/connections', { name: 'Demo responses', kind: 'mock' });
    expect(mocked.put).toHaveBeenCalledWith('/api/models/defaults', { chat: 'demo' });
  });
  it('keeps a hosted model endpoint when selecting a discovered chat model', async () => {
    mocked.get.mockResolvedValue({ project: { name: 'Workspace' }, connections: 0 });
    const saved = { id: 'my-model', kind: 'openai', name: 'My model', baseUrl: 'https://provider.example/v1', embeddingModel: 'embed-v1', aliases: {} };
    mocked.post.mockImplementation(async path => path.endsWith('/test') ? { ok: true, models: [{ id: 'chat-v1', kind: 'chat' }] } : saved);
    mocked.put.mockResolvedValue({});
    await setup(document.querySelector('main'), {}, { navigate: vi.fn() });
    const url = document.querySelector('input[type=url]'); url.value = saved.baseUrl; url.dispatchEvent(new Event('input'));
    button('Connect and test').click();
    await vi.waitFor(() => expect(mocked.put).toHaveBeenCalledWith('/api/models/connections/my-model', expect.objectContaining({ baseUrl: saved.baseUrl, chatModel: 'chat-v1', embeddingModel: 'embed-v1' })));
  });
  it('filters templates and creates the selected real flow', async () => {
    mocked.get.mockResolvedValue([
      { id: 'first-workflow', name: 'Your First API', description: 'Returns JSON', category: 'Getting started', definition: { nodes: [{ data: { nodeId: 'graphqlNode' } }] } },
      { id: 'chat', name: 'Chat', description: 'Ask your model', category: 'Chat', definition: { nodes: [{ data: { nodeId: 'LLMNode' } }] } },
    ]);
    mocked.post.mockResolvedValue({ id: 'selected' });
    const navigate = vi.fn();
    await templates(document.querySelector('main'), {}, { navigate });
    expect(document.querySelectorAll('.template-grid .card')).toHaveLength(2);
    const search = document.querySelector('input'); search.value = 'JSON'; search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.template-grid .card')).toHaveLength(1);
    button('Use template').click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/flows/selected'));
    expect(mocked.post).toHaveBeenCalledWith('/api/flows', { templateId: 'first-workflow' });
  });
});
