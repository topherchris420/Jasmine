import { renderMarkdown } from './markdown.js';

const flowId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
const params = new URLSearchParams(location.search);
const embedded = params.get('embed') === '1';
const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
const send = $('send');
const storageKey = `jasmine.chat.${flowId}`;
let config = { mode: 'chat' };
let busy = false;

const store = {
  get() {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  },
  set(v) {
    try {
      if (v) localStorage.setItem(storageKey, v);
      else localStorage.removeItem(storageKey);
    } catch {
      /* storage blocked: the session lasts for this page */
    }
  },
};
let sessionId = store.get();

function bubble(role, text) {
  const el = document.createElement('div');
  el.className = `msg msg-${role}`;
  if (role === 'bot') el.append(renderMarkdown(text));
  else el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function references(el, refs) {
  if (!Array.isArray(refs) || !refs.length) return;
  const box = document.createElement('div');
  box.className = 'refs';
  const seen = new Set();
  for (const r of refs.slice(0, 6)) {
    const label = String(r?.title ?? r?.name ?? r?.source ?? r?.url ?? r?.link ?? '').slice(0, 80);
    const url = String(r?.url ?? r?.link ?? r?.source ?? '');
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const item = /^https?:/i.test(url) ? Object.assign(document.createElement('a'), { href: url, target: '_blank', rel: 'noopener noreferrer' }) : document.createElement('span');
    item.textContent = label;
    item.title = label;
    box.append(item);
  }
  if (box.childElementCount) el.append(box);
}

function typing() {
  const el = document.createElement('div');
  el.className = 'msg msg-bot';
  el.innerHTML = '<span class="typing" aria-label="Thinking"><i></i><i></i><i></i></span>';
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function greet() {
  log.replaceChildren();
  if (config.greetingMessage) bubble('bot', config.greetingMessage);
  const s = $('suggestions');
  s.replaceChildren();
  for (const q of (Array.isArray(config.suggestions) ? config.suggestions : []).filter(Boolean).slice(0, 6)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = q;
    b.addEventListener('click', () => void ask(q));
    s.append(b);
  }
}

async function readStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) onEvent(event, JSON.parse(data));
    }
  }
}

async function ask(text) {
  const message = text.trim();
  if (!message || busy) return;
  busy = true;
  send.disabled = true;
  $('suggestions').replaceChildren();
  bubble('user', message);
  input.value = '';
  input.style.height = '';
  const pending = typing();
  let streamed = '';
  let target = null;
  try {
    const res = await fetch(`/api/${config.mode === 'ask' ? 'ask' : 'chat'}/${encodeURIComponent(flowId)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatMessage: message, ...(sessionId ? { sessionId } : {}), stream: true }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.errors?.[0]?.message ?? `Request failed (${res.status})`);
    }
    await readStream(res, (event, data) => {
      if (event === 'session' && data.sessionId) {
        sessionId = data.sessionId;
        store.set(sessionId);
      } else if (event === 'token') {
        streamed += data.text ?? '';
        if (!target) {
          target = pending;
          target.textContent = '';
        }
        target.replaceChildren(renderMarkdown(streamed));
        log.scrollTop = log.scrollHeight;
      } else if (event === 'message') {
        if (data.status !== 'success') throw new Error(data.error?.message ?? 'Something went wrong. Please try again.');
        const el = target ?? pending;
        el.replaceChildren(renderMarkdown(data.output?.content ?? streamed));
        references(el, data.output?.references);
        target = el;
      } else if (event === 'error') {
        throw new Error(data.message ?? 'Something went wrong');
      }
    });
    if (!target) pending.remove();
  } catch (e) {
    if (!target) pending.remove();
    const err = document.createElement('div');
    err.className = 'msg-error';
    err.textContent = e.message;
    log.append(err);
  } finally {
    busy = false;
    send.disabled = false;
    log.scrollTop = log.scrollHeight;
    input.focus();
  }
}

async function loadHistory() {
  if (!sessionId || config.mode !== 'chat') return;
  try {
    const res = await fetch(`/api/chat/${encodeURIComponent(flowId)}/history?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const history = await res.json();
    if (Array.isArray(history) && history.length) {
      $('suggestions').replaceChildren();
      for (const m of history) bubble(m.role === 'user' ? 'user' : 'bot', m.content);
    }
  } catch {
    /* start fresh */
  }
}

async function init() {
  try {
    const res = await fetch(`/api/chat/${encodeURIComponent(flowId)}/config`);
    if (res.ok) config = await res.json();
  } catch {
    /* defaults */
  }
  const name = config.botName || 'Assistant';
  document.title = name;
  $('title').textContent = name;
  $('avatar').textContent = name.trim()[0]?.toUpperCase() ?? 'J';
  const primary = config.colors?.primary;
  if (typeof primary === 'string' && /^#[0-9a-f]{3,8}$/i.test(primary)) document.documentElement.style.setProperty('--brand', primary);
  if (config.placeholder) input.placeholder = config.placeholder;
  greet();
  await loadHistory();
  if (embedded) {
    const close = $('close');
    close.hidden = false;
    close.addEventListener('click', () => parent.postMessage({ type: 'jasmine:close', flowId }, '*'));
  }
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  void ask(input.value);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void ask(input.value);
  }
});
input.addEventListener('input', () => {
  input.style.height = '';
  input.style.height = `${Math.min(140, input.scrollHeight)}px`;
});
$('reset').addEventListener('click', () => {
  sessionId = null;
  store.set(null);
  greet();
  input.focus();
});

void init();
