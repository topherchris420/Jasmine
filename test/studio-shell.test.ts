/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Stubs fetch: /api/status answers with `status`; every other call is recorded and answered with `{}` (or a 404 body). */
function stubServer(status: Record<string, unknown> | null) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith('/api/status')) return status ? json(status) : json({ errors: [{ message: 'nope' }] }, 500);
    calls.push({ url: String(url), headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) });
    return json({ errors: [{ message: 'Not found', extensions: { code: 'NOT_FOUND' } }] }, 404);
  }));
  return calls;
}

const load = (modulePath: string): Promise<any> => import(/* @vite-ignore */ modulePath);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Studio API client and JASMINE_PROJECT_ID', () => {
  it('sends the required project id on every authenticated call', async () => {
    const calls = stubServer({ name: 'Jasmine', project: { name: 'P', id: 'local' }, requiredProjectId: 'proj1' });
    const { api, authHeaders } = await load('../public/js/api.js');
    await api.get('/api/flows').catch(() => {});
    await api.post('/api/flows', { name: 'x' }).catch(() => {});
    expect(calls.map((c) => c.headers['x-project-id'])).toEqual(['proj1', 'proj1']);
    expect(await authHeaders()).toMatchObject({ 'x-project-id': 'proj1' });
  });

  it('sends no project header when the server does not require (or report) one', async () => {
    for (const status of [{ name: 'Jasmine', requiredProjectId: null }, { name: 'Jasmine' }, null]) {
      vi.resetModules();
      const calls = stubServer(status);
      const { api } = await load('../public/js/api.js');
      await api.get('/api/flows').catch(() => {});
      expect(calls[0]!.headers['x-project-id']).toBeUndefined();
    }
  });
});

describe('Studio shell navigation', () => {
  it('labels the collapsible nav links and gives the mobile drawer an accessible open/close cycle', async () => {
    stubServer({ name: 'Jasmine', project: { name: 'P', id: 'local' } });
    document.body.innerHTML = '<div id="app"></div>';
    history.replaceState(null, '', '/logs');
    await load('../public/js/main.js');
    // Let the routed page finish rendering (its API call fails with the stubbed 404) before inspecting the shell.
    await vi.waitFor(() => expect(document.querySelector('#main .callout')).toBeTruthy());
    const links = [...document.querySelectorAll('.sidebar a.nav-item')];
    expect(links.length).toBeGreaterThan(10);
    for (const a of links) expect(a.getAttribute('aria-label')).toBeTruthy();
    expect(document.querySelector('.sidebar a.brand')!.getAttribute('aria-label')).toBe('Jasmine home');

    const menu = document.querySelector('.mobile-bar button')!;
    const open = () => (menu as HTMLButtonElement).click();
    const isOpen = () => document.body.classList.contains('nav-open');
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(menu.getAttribute('aria-controls')).toBe('sidebar');

    open();
    expect(isOpen()).toBe(true);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(isOpen()).toBe(false);
    expect(menu.getAttribute('aria-expanded')).toBe('false');

    open();
    (document.querySelector('.nav-backdrop') as HTMLElement).click();
    expect(isOpen()).toBe(false);

    open();
    (document.querySelector('.sidebar a[href="/logs"]') as HTMLAnchorElement).click(); // the page already shown
    expect(isOpen()).toBe(false);
    expect(location.pathname).toBe('/logs');
  });
});
