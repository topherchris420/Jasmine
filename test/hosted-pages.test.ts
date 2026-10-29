/// <reference lib="dom" />
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const body = (file: string) => /<body>([\s\S]*)<\/body>/.exec(readFileSync(path.join(import.meta.dirname, '../public/apps', file), 'utf8'))![1]!;
const page = body('chat.html');
const chatModule = '../public/apps/chat.js';
const searchModule = '../public/apps/search.js';
type Reply = { ok: boolean; status: number; body?: ReadableStream<Uint8Array>; json(): Promise<unknown> };
let post: (body: { chatMessage: string }) => Promise<Reply>;

/** A streamed answer, as the chat route sends it; `push` adds events while the stream stays open. */
function stream(events: [string, unknown][] = [], open = false) {
  let push!: (event: string, data: unknown) => void;
  let end!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (event, data) => controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      end = () => controller.close();
      for (const [event, data] of events) push(event, data);
      if (!open) end();
    },
  });
  return { reply: { ok: true, status: 200, body, json: async () => ({}) } as Reply, push, end };
}
const refused = (status: number, body?: unknown): Reply => ({ ok: false, status, json: async () => { if (body === undefined) throw new SyntaxError('empty'); return body; } });
const answer = (content: string, extra: Record<string, unknown> = {}) => stream([['session', { sessionId: 'session-1234' }], ['message', { status: 'success', output: { content }, ...extra }]]).reply;

async function open() {
  history.replaceState(null, '', '/apps/chat/demo');
  document.body.innerHTML = page;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') return post(JSON.parse(init.body!));
    if (url.endsWith('/config')) return { ok: true, status: 200, json: async () => ({ mode: 'chat', botName: 'Ada', greetingMessage: 'Hello' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }));
  vi.resetModules();
  await import(/* @vite-ignore */ chatModule);
  await vi.waitFor(() => expect(document.getElementById('title')!.textContent).toBe('Ada'));
}
async function say(text: string) {
  const input = document.getElementById('input') as HTMLTextAreaElement;
  input.value = text;
  document.getElementById('composer')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false));
}
const notes = () => [...document.querySelectorAll('.note')].map((n) => n.textContent);
const bubbles = (who: 'user' | 'bot') => [...document.querySelectorAll(`.msg-${who}`)].map((m) => m.textContent);

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('The hosted chat page', () => {
  it('says when a message never left, and sends the same message again from the same bubble', async () => {
    await open();
    post = async () => { throw new TypeError('Failed to fetch'); };
    await say('Are you there?');
    expect(notes()).toEqual(['Couldn’t reach the assistant. Check your connection, then try again.Try again']);
    expect(document.querySelector('.msg-user')!.classList.contains('unsent')).toBe(true);

    post = async () => answer('Yes, here.');
    (document.querySelector('.note button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(bubbles('bot')).toEqual(['Hello', 'Yes, here.']));
    expect(bubbles('user')).toEqual(['Are you there?']);
    expect(document.querySelector('.msg-user')!.classList.contains('unsent')).toBe(false);
    expect(notes()).toEqual([]);
  });

  it('puts an unreachable runtime, a rate limit and a vanished chat in plain words', async () => {
    await open();
    post = async () => refused(502);
    await say('one');
    post = async () => refused(429, { errors: [{ message: 'Too many requests. Wait a minute, then try again.', extensions: { code: 'RATE_LIMITED' } }] });
    await say('two');
    post = async () => refused(404, { errors: [{ message: 'Workflow not found or not deployed', extensions: { code: 'NOT_FOUND' } }] });
    await say('three');
    expect(notes()).toEqual([
      'Couldn’t reach the assistant. Your message wasn’t sent.Try again',
      'That’s a lot of messages at once. Wait a moment, then try again.Try again',
      'This chat isn’t available anymore.',
    ]);
  });

  it('never leaves half an answer standing as an answer, and labels demo responses', async () => {
    await open();
    post = async () => stream([['token', { text: 'The capital of' }]]).reply;
    await say('cut off');
    expect(bubbles('bot')).toEqual(['Hello']);
    expect(notes()).toEqual(['The connection closed before the answer finished.Try again']);

    post = async () => stream([['token', { text: 'Partial' }], ['message', { status: 'failed', error: { code: 'NETWORK', message: 'Couldn’t reach the AI model behind this page. Please try again in a moment.' } }]]).reply;
    await say('failed');
    expect(bubbles('bot')).toEqual(['Hello']);
    expect(notes()[1]).toBe('Couldn’t reach the AI model behind this page. Please try again in a moment.Try again');

    post = async () => answer('echo: hi', { demo: true });
    await say('hi');
    expect(bubbles('bot')).toEqual(['Hello', 'echo: hi']);
    expect(document.querySelector('.meta')!.textContent).toBe('Demo response · no AI inference');
  });

  it('counts the seconds while it waits, and says so when the model reports thinking', async () => {
    await open();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const answer = stream([], true);
    post = async () => answer.reply;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = 'Think hard';
    document.getElementById('composer')!.dispatchEvent(new Event('submit', { cancelable: true }));
    const wait = () => document.querySelector('.wait')?.textContent;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(wait()).toBe('');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(wait()).toBe('Waiting for the answer · 6 s');
    answer.push('progress', { thinkingMs: 1200 });
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(wait()).toMatch(/^Thinking · \d+ s$/);
    });
    answer.push('message', { status: 'success', output: { content: 'Done.' } });
    answer.end();
    await vi.waitFor(() => expect(bubbles('bot')).toEqual(['Hello', 'Done.']));
    expect(document.getElementById('log')!.getAttribute('aria-busy')).toBe('false');
  });
});

describe('The hosted search page', () => {
  it('says what happened when a search fails or finds nothing, in plain words', async () => {
    history.replaceState(null, '', '/apps/search/docs');
    document.body.innerHTML = body('search.html');
    let reply: () => Promise<Reply> = async () => refused(502);
    vi.stubGlobal('fetch', vi.fn(async () => reply()));
    vi.resetModules();
    await import(/* @vite-ignore */ searchModule);
    const status = document.getElementById('status')!;
    const search = async (q: string) => {
      (document.getElementById('q') as HTMLInputElement).value = q;
      document.getElementById('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await vi.waitFor(() => expect(status.textContent).not.toBe('Searching…'));
    };
    await search('tea');
    expect(status.textContent).toBe('Couldn’t reach the search. Please try again in a moment.');
    reply = async () => { throw new TypeError('Failed to fetch'); };
    await search('tea');
    expect(status.textContent).toBe('Couldn’t reach the search. Check your connection, then try again.');
    reply = async () => ({ ok: true, status: 200, json: async () => ({ status: 'success', results: [] }) });
    await search('quantum gravity');
    expect(status.textContent).toBe('Nothing matched “quantum gravity”. Try other words.');
    reply = async () => ({ ok: true, status: 200, json: async () => ({ status: 'success', results: [{ title: 'Install Jasmine', content: 'Clone, then npm ci.', link: 'https://example.com/install' }] }) });
    await search('install');
    expect(status.textContent).toBe('1 result');
    expect(document.querySelector('.result h3 a')!.getAttribute('href')).toBe('https://example.com/install');
  });
});
