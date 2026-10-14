import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { JasmineClient } from './jasmine.mjs';

/** React/Next.js client hook. Supply an execute key only when appropriate for your app's audience. */
export function useJasmineFlow({ endpoint, flowId, apiKey, projectId }) {
  const client = useMemo(() => new JasmineClient({ endpoint, apiKey, projectId }), [endpoint, apiKey, projectId]);
  const [state, setState] = useState({ status: 'idle', output: null, error: null, tokens: '', requestId: null });
  const pending = useRef(null);
  const execute = useCallback(
    async (payload, options = {}) => {
      if (pending.current) throw new Error('A run is already active');
      const controller = new AbortController();
      pending.current = { controller, id: null };
      setState({ status: 'in-progress', output: null, error: null, tokens: '', requestId: null });
      try {
        const accepted = await client.executeFlow(flowId, payload, {
          ...options,
          mode: 'async',
          signal: controller.signal,
        });
        pending.current.id = accepted.requestId;
        setState((s) => ({ ...s, requestId: accepted.requestId }));
        const streaming = (async () => {
          for await (const e of client.events(accepted.requestId, { signal: controller.signal })) {
            if (e.event === 'node.token') setState((s) => ({ ...s, tokens: s.tokens + String(e.data?.data ?? '') }));
          }
        })().catch(() => {});
        const result = await client.wait(accepted.requestId, { signal: controller.signal });
        controller.abort();
        await streaming;
        setState((s) => ({ ...s, status: result.status, output: result.output, error: result.error ?? null }));
        return result;
      } catch (error) {
        setState((s) => ({ ...s, status: 'error', error: { message: error.message } }));
        throw error;
      } finally {
        pending.current = null;
      }
    },
    [client, flowId],
  );
  const cancel = useCallback(async () => {
    const run = pending.current;
    if (run?.id) await client.cancel(run.id);
    run?.controller.abort();
  }, [client]);
  useEffect(() => () => pending.current?.controller.abort(), []);
  return { ...state, execute, cancel };
}

/** Minimal chat component for a deployed public Chat Widget trigger. Styles belong to your app. */
export function JasmineChat({ endpoint = 'http://127.0.0.1:8787', flowId, className, onError }) {
  const [messages, setMessages] = useState([]),
    [input, setInput] = useState(''),
    [busy, setBusy] = useState(false);
  const session = useRef(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    setBusy(true);
    const message = input;
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: message }]);
    try {
      const client = new JasmineClient({ endpoint });
      const r = await client.request(`/api/chat/${encodeURIComponent(flowId)}`, {
        method: 'POST',
        body: { chatMessage: message, sessionId: session.current },
      });
      session.current = r.sessionId;
      if (r.status !== 'success') throw new Error(r.error?.message || 'Chat failed');
      setMessages((m) => [...m, { role: 'assistant', content: r.output.content }]);
    } catch (error) {
      onError?.(error);
      setMessages((m) => [...m, { role: 'error', content: error.message }]);
    } finally {
      setBusy(false);
    }
  };
  return createElement(
    'section',
    { className, 'aria-label': 'Jasmine chat' },
    createElement(
      'div',
      { 'aria-live': 'polite' },
      ...messages.map((m, i) => createElement('p', { key: i, 'data-role': m.role }, m.content)),
    ),
    createElement(
      'form',
      { onSubmit: submit },
      createElement('input', {
        value: input,
        onChange: (e) => setInput(e.target.value),
        'aria-label': 'Message',
        disabled: busy,
      }),
      createElement('button', { type: 'submit', disabled: busy }, busy ? 'Sending…' : 'Send'),
    ),
  );
}
