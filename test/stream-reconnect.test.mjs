import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../public/js/api.js';
const stream = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
afterEach(() => vi.unstubAllGlobals());
describe('Studio event streams behind the gateway', () => {
  it('reconnects an interrupted GET run stream and receives the final result', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(stream('event: node.token\ndata: "hello"\n\n')).mockResolvedValueOnce(stream('event: done\ndata: {"status":"success","output":{"message":"done"}}\n\n'));
    vi.stubGlobal('fetch', fetcher);
    const events = [];
    await new Promise((resolve, reject) => api.stream('/api/runs/run-id/events', undefined, (event, data) => events.push([event, data]), error => error ? reject(error) : resolve()));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(events.map(e => e[0])).toEqual(['node.token', 'done']);
    expect(events[1][1].output.message).toBe('done');
  });
  it('does not replay a POST stream that can cause side effects', async () => {
    const fetcher = vi.fn().mockResolvedValue(stream('event: node.token\ndata: "partial"\n\n'));
    vi.stubGlobal('fetch', fetcher);
    await new Promise(resolve => api.stream('/api/chat/example', { chatMessage: 'hello' }, () => {}, resolve));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('aborts pending reconnection when the user leaves the page', async () => {
    const fetcher = vi.fn().mockResolvedValue(stream(''));
    vi.stubGlobal('fetch', fetcher);
    const done = vi.fn();
    const abort = api.stream('/api/runs/run-id/events', undefined, () => {}, done);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    abort();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
  });
});
