// @vitest-environment happy-dom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JasmineChat, useJasmineFlow } from '../sdk/react.mjs';

let root, container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const json = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

describe('optional React integration', () => {
  it('executes an async flow and presents its completed output', async () => {
    let flow;
    const http = vi.fn(async (url) =>
      url.endsWith('/execute')
        ? json({ status: 'in-progress', requestId: 'run' })
        : url.endsWith('/events')
          ? new Response('event: done\ndata: {"status":"success"}\n\n', {
              headers: { 'content-type': 'text/event-stream' },
            })
          : json({ status: 'success', requestId: 'run', output: { answer: 42 } }),
    );
    vi.stubGlobal('fetch', http);
    function App() {
      flow = useJasmineFlow({ endpoint: 'http://localhost:8787', flowId: 'echo' });
      return createElement('div', {}, flow.status);
    }
    await act(async () => root.render(createElement(App)));
    await act(async () => {
      await flow.execute({ question: 'answer' });
    });
    expect(flow.status).toBe('success');
    expect(flow.output).toEqual({ answer: 42 });
    expect(JSON.parse(http.mock.calls[0][1].body)).toEqual({ mode: 'async', payload: { question: 'answer' } });
  });
  it('sends chat input, displays output, and reuses the conversation session', async () => {
    const requests = [];
    vi.stubGlobal('fetch', async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return json({ status: 'success', sessionId: 'session-1', output: { content: 'Hello from Jasmine' } });
    });
    await act(async () => root.render(createElement(JasmineChat, { flowId: 'chat' })));
    async function send(text) {
      const input = container.querySelector('input');
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await act(async () => {
        container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    }
    await send('First');
    expect(container.textContent).toContain('Hello from Jasmine');
    await send('Second');
    expect(requests).toEqual([
      { chatMessage: 'First', sessionId: null },
      { chatMessage: 'Second', sessionId: 'session-1' },
    ]);
  });
});
