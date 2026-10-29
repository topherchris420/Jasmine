/// <reference lib="dom" />
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(), stream: vi.fn(), catalog: vi.fn() }));
vi.mock('../public/js/api.js', () => ({ api: mocked, catalog: mocked.catalog, ApiError: class extends Error {}, onAuthRequired: vi.fn(), setKey: vi.fn() }));

const mainModule = '../public/js/main.js';

describe('Studio at an address that does not exist', () => {
  it('says so in its own page and offers a way back', async () => {
    history.replaceState(null, '', '/overview');
    document.body.innerHTML = '<div id="app" class="app"></div>';
    const answers: Record<string, unknown> = { '/api/status': { authRequired: false, project: { name: 'Workspace' } }, '/api/auth/session': { authenticated: true }, '/api/setup': { complete: true } };
    mocked.get.mockImplementation(async (path: string) => answers[path] ?? {});
    await import(/* @vite-ignore */ mainModule);
    await vi.waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('This page doesn’t exist'));
    expect(document.body.textContent).toContain('Nothing lives at /overview.');
    expect([...document.querySelectorAll('.empty a.btn')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Go to Home', '/'], ['Your workflows', '/flows']]);
    expect(document.title).toBe('Page not found · Jasmine');
  });
});
