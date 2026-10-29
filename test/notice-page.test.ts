/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noticePage } from '../hosting/notice.mjs';

/** Shows a notice page as a browser would, running its inline script. */
function open(state: 'offline' | 'missing', path: string) {
  history.replaceState(null, '', path);
  const doc = new DOMParser().parseFromString(noticePage({ app: 'chat', state }).body, 'text/html');
  for (const attr of [...document.documentElement.attributes]) document.documentElement.removeAttribute(attr.name);
  for (const attr of [...doc.documentElement.attributes]) document.documentElement.setAttribute(attr.name, attr.value);
  document.body.innerHTML = doc.body.innerHTML;
  new Function(doc.querySelector('script')!.textContent!)();
}
const text = (id: string) => document.getElementById(id)?.textContent;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('The page visitors see while the runtime is away', () => {
  it('checks again further apart each time, waits while hidden, and opens the chat once the runtime answers', async () => {
    vi.useFakeTimers();
    const reload = vi.spyOn(location, 'reload').mockImplementation(() => {});
    const probe = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', probe);
    open('offline', '/apps/chat/jasmine-demo');
    expect(text('next')).toBe('Checking again in 0:10');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]).toEqual([location.href, expect.objectContaining({ method: 'HEAD', cache: 'no-store' })]);
    expect(text('next')).toBe('Checking again in 0:20');

    // Nobody is looking: no checks until the tab is visible again, then one straight away.
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(false);
    probe.mockResolvedValue(new Response(null, { status: 200 }));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(document.documentElement.classList.contains('bloom')).toBe(true);
    expect(text('status')).toBe('It’s back. Opening the chat…');
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('stops after about half an hour, and Try again checks at once', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', probe);
    open('offline', '/apps/chat/jasmine-demo');
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(probe).toHaveBeenCalledTimes(10);
    expect(text('status')).toBe('Still away. Try again whenever you like.');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(probe).toHaveBeenCalledTimes(10);
    document.getElementById('again')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(11);
    expect(text('next')).toBe('Checking again in 0:10');
  });

  it('gives the embedded widget a way out, and shows no countdown for a link that leads nowhere', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    open('offline', '/apps/chat/jasmine-demo?embed=1');
    const close = document.getElementById('close')!;
    expect(close.hidden).toBe(false);
    close.click();
    expect(post).toHaveBeenCalledWith({ type: 'jasmine:close', flowId: 'jasmine-demo' }, '*');

    open('missing', '/apps/chat/nope');
    expect(document.getElementById('close')!.hidden).toBe(true);
    expect(document.getElementById('next')).toBeNull();
    expect(document.querySelector('h1')!.textContent).toBe('This chat isn’t available.');
  });
});
