/// <reference lib="dom" />
// @vitest-environment happy-dom
import { execFileSync, spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(), catalog: vi.fn(), projectId: vi.fn() }));
vi.mock('../public/js/api.js', () => ({ api: mocked, catalog: mocked.catalog, projectId: mocked.projectId, getKey: () => '', setKey: () => {} }));
vi.mock('../public/js/main.js', () => ({ setProjectName: vi.fn() }));

// Browser modules are plain JavaScript without declarations; load them through a variable path, as the other Studio tests do.
const load = (modulePath: string): Promise<any> => import(/* @vite-ignore */ modulePath);
const ui = await load('../public/js/ui.js');
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<main id="app"></main>';
  history.replaceState(null, '', '/');
});

describe('keyboard access to list rows', () => {
  it('makes clickable rows focusable and opens them with Enter or Space, but not from inner controls', () => {
    const opened: string[] = [];
    const inner = vi.fn();
    const table = ui.table(
      [{ label: 'Name', render: (r: { id: string }) => r.id }, { label: '', render: () => ui.button('Delete', { onClick: inner }) }],
      [{ id: 'run-1' }, { id: 'run-2' }],
      { onRowClick: (r: { id: string }) => opened.push(r.id) },
    );
    document.body.append(table);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '0']);
    expect(key(rows[0]!, 'Enter').defaultPrevented).toBe(true);
    key(rows[1]!, ' ');
    key(rows[1]!, 'a');
    key(rows[0]!.querySelector('button')!, 'Enter');
    expect(opened).toEqual(['run-1', 'run-2']);
  });

  it('leaves plain tables out of the tab order', () => {
    const table = ui.table([{ label: 'Name', key: 'id' }], [{ id: 'x' }]);
    expect(table.querySelector('tbody tr')!.hasAttribute('tabindex')).toBe(false);
  });
});

describe('code text boxes', () => {
  it('indent with Tab, release the next Tab after Escape, and describe that to screen readers', () => {
    const box = ui.textarea('{}', () => {}, { mono: true });
    document.body.append(box);
    box.focus();
    box.dispatchEvent(new Event('focus'));
    const hint = document.getElementById(box.getAttribute('aria-describedby')!);
    expect(hint?.textContent).toContain('Press Escape, then Tab');
    box.setSelectionRange(1, 1);
    expect(key(box, 'Tab').defaultPrevented).toBe(true);
    expect(box.value).toBe('{  }');
    key(box, 'Escape');
    expect(key(box, 'Tab').defaultPrevented).toBe(false);
    expect(key(box, 'Tab').defaultPrevented).toBe(true); // released only once
    expect(key(box, 'Tab', { shiftKey: true }).defaultPrevented).toBe(false);
  });
});

describe('Logs time range', () => {
  it('keeps "All time" in the URL so reloads and Back restore it', async () => {
    mocked.get.mockImplementation(async (path: string) => (path === '/api/flows' ? [] : { runs: [], nextBefore: null }));
    const { render } = await load('../public/js/pages/logs.js');
    const container = document.getElementById('app')!;
    await render(container, {}, { navigate: () => {}, query: new URLSearchParams() });
    const range = container.querySelector('select[aria-label="Time range"]') as HTMLSelectElement;
    range.value = 'all';
    range.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(location.search).toBe('?days=all'));
    const lastRuns = mocked.get.mock.calls.map(([p]) => p as string).filter((p) => p.startsWith('/api/runs')).at(-1)!;
    expect(lastRuns).not.toContain('from=');

    // A reload renders from the URL: still all time, so the runs query has no lower bound.
    mocked.get.mockClear();
    document.body.innerHTML = '<main id="app"></main>';
    await render(document.getElementById('app')!, {}, { navigate: () => {}, query: new URLSearchParams(location.search) });
    const reloaded = mocked.get.mock.calls.map(([p]) => p as string).filter((p) => p.startsWith('/api/runs'));
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).not.toContain('from=');
    expect(location.search).toBe('?days=all');
  });
});

describe('Settings project import', () => {
  const settings = { project: { name: 'P', id: 'local' }, secrets: [], env: {}, retention: { maxRuns: 1, maxAgeDays: 1 }, auth: { adminEnabled: false, executeEnabled: false } };

  it('validates an export file and posts its flows to /api/import', async () => {
    const { parseProjectExport, render } = await load('../public/js/pages/settings.js');
    expect(() => parseProjectExport('{"nodes":[]}')).toThrow(/project export/);
    expect(() => parseProjectExport('nope')).toThrow(/not valid JSON/);
    mocked.get.mockImplementation(async (path: string) => (path === '/api/keys' ? [] : settings));
    mocked.post.mockResolvedValue({ imported: [{ id: 'a' }], message: 'Imported drafts only.' });
    const container = document.getElementById('app')!;
    await render(container);
    expect(document.querySelector('input[type=file][accept=".json"]')!.closest('label')?.textContent).toContain('Backup file to restore');
    expect(button('Import project')).toBeTruthy();
    const input = container.querySelector('input[aria-label="Project export file to import"]') as HTMLInputElement;
    const exported = { format: 'jasmine-project', version: 1, exportedAt: 'x', prompts: [], flows: [{ id: 'a', name: 'A', definition: { nodes: [], edges: [] } }] };
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([JSON.stringify(exported)], 'project.json', { type: 'application/json' })] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(button('Import')).toBeTruthy());
    button('Import').click();
    await vi.waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/api/import', { format: 'jasmine-project', version: 1, flows: [{ id: 'a', name: 'A', definition: { nodes: [], edges: [] } }] }),
    );
  });
});

describe('generated client code', () => {
  const tricky = { message: "is this true or null? it's false", quote: '"\'\\', newline: 'a\nb\tc', unicode: 'héllo ✓  ', nested: { ok: true, none: null, n: [1, 2.5, -3] } };

  it('adds x-project-id to every snippet when the server requires one', async () => {
    const { snippets } = await load('../public/js/pages/deployment.js');
    const sn = snippets({ flowId: 'f', payload: {}, key: null, base: 'http://h', projectId: 'proj1' });
    for (const lang of ['curl', 'rest', 'javascript', 'python'] as const) expect(sn[lang]).toContain('proj1');
    expect(snippets({ flowId: 'f', payload: {}, key: null, base: 'http://h' }).curl).not.toContain('x-project-id');
  });

  it.skipIf(spawnSync('python3', ['--version']).status !== 0)('produces a Python payload that round-trips exactly', async () => {
    const { snippets } = await load('../public/js/pages/deployment.js');
    const code = snippets({ flowId: 'f', payload: tricky, key: null, base: 'http://h' }).python;
    const line = code.split('\n').find((l: string) => l.startsWith('payload = json.loads('))!;
    const out = execFileSync('python3', ['-I', '-c', `import json\n${line}\nprint(json.dumps(payload))`], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual(tricky);
  });
});

describe('hosted chat markdown', () => {
  it('keeps snake_case and parenthesised URLs intact and never emits unsafe links', async () => {
    const { renderMarkdown } = await load('../public/apps/markdown.js');
    const html = (s: string) => {
      const d = document.createElement('div');
      d.append(renderMarkdown(s));
      return d.innerHTML;
    };
    expect(html('Set my_config_value now, _really_.')).toBe('<p>Set my_config_value now, <em>really</em>.</p>');
    expect(html('See [Python](https://en.wikipedia.org/wiki/Python_(programming_language)).')).toContain('href="https://en.wikipedia.org/wiki/Python_(programming_language)"');
    expect(html('Go to https://example.com/a_(b). Done')).toContain('href="https://example.com/a_(b)"');
    const hostile = html('[x](javascript:alert(1)) [y](javascript:alert((1))) <img src=x onerror=alert(1)> <script>alert(2)</script> [z](data:text/html,hi)');
    const d = document.createElement('div');
    d.innerHTML = hostile;
    expect(d.querySelectorAll('img, script').length).toBe(0);
    expect([...d.querySelectorAll('a')].length).toBe(0);
  });
});
