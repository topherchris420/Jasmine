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

function waiting() {
  const el = document.createElement('div');
  el.className = 'msg msg-bot';
  // The seconds count is for eyes only; a screen reader hears "Waiting for the answer" once, not every second.
  el.innerHTML = '<span class="typing" role="img" aria-label="Waiting for the answer"><i></i><i></i><i></i></span><span class="wait" aria-hidden="true"></span>';
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

const elapsed = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);
const ALERT = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.5h.01"/></svg>';

/** A line in the conversation saying what went wrong, with a way to try again when that can help. */
function note(text, retry) {
  const el = document.createElement('div');
  el.className = 'note';
  el.innerHTML = ALERT;
  const line = Object.assign(document.createElement('span'), { textContent: text });
  if (retry) {
    const again = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Try again' });
    again.addEventListener('click', () => {
      el.remove();
      retry();
    });
    line.append(again);
  }
  el.append(line);
  log.append(el);
}

/** What a visitor reads when the message was refused or never reached the assistant. */
async function refused(res) {
  const body = await res.json().catch(() => null);
  const error = body?.errors?.[0];
  if (res.status === 429) return { text: error?.extensions?.code === 'OVERLOADED' ? 'The assistant is busy right now. Try again in a moment.' : 'That’s a lot of messages at once. Wait a moment, then try again.', unsent: true };
  if (res.status === 404) return { text: 'This chat isn’t available anymore.', unsent: true, final: true };
  if (res.status >= 500) return { text: 'Couldn’t reach the assistant. Your message wasn’t sent.', unsent: true };
  return { text: error?.message ?? 'The message couldn’t be sent.', unsent: true, final: true };
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

async function ask(text, again) {
  const message = text.trim();
  if (!message || busy) return;
  busy = true;
  send.disabled = true;
  $('suggestions').replaceChildren();
  const mine = again ?? bubble('user', message);
  mine.classList.remove('unsent');
  if (!again) {
    input.value = '';
    input.style.height = '';
  }
  const pending = waiting();
  const wait = pending.querySelector('.wait');
  const started = Date.now();
  let thinking = false;
  const clock = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    if (seconds >= 5) wait.textContent = `${thinking ? 'Thinking' : 'Waiting for the answer'} · ${elapsed(seconds)}`;
  }, 1000);
  let streamed = '';
  let answered = false;
  let problem = null;
  log.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(`/api/${config.mode === 'ask' ? 'ask' : 'chat'}/${encodeURIComponent(flowId)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatMessage: message, ...(sessionId ? { sessionId } : {}), stream: true }),
    });
    if (!res.ok) problem = await refused(res);
    else {
      await readStream(res, (event, data) => {
        if (event === 'session' && data.sessionId) {
          sessionId = data.sessionId;
          store.set(sessionId);
        } else if (event === 'progress') {
          thinking = true;
        } else if (event === 'token') {
          clearInterval(clock);
          streamed += data.text ?? '';
          pending.replaceChildren(renderMarkdown(streamed));
          log.scrollTop = log.scrollHeight;
        } else if (event === 'message' && data.status === 'success') {
          answered = true;
          pending.replaceChildren(renderMarkdown(data.output?.content ?? streamed));
          references(pending, data.output?.references);
          if (data.demo) log.append(Object.assign(document.createElement('div'), { className: 'meta', textContent: 'Demo response · no AI inference' }));
        } else if (event === 'message' || event === 'error') {
          problem = { text: (event === 'message' ? data.error?.message : data.message) ?? 'Something went wrong while answering. Please try again in a moment.' };
        }
      });
      // A stream that ends without its final message was cut off, by a proxy's time limit for example.
      if (!answered && !problem) problem = { text: streamed ? 'The connection closed before the answer finished.' : 'The connection closed before the answer arrived.' };
    }
  } catch {
    problem = { text: 'Couldn’t reach the assistant. Check your connection, then try again.', unsent: true };
  } finally {
    clearInterval(clock);
    log.setAttribute('aria-busy', 'false');
    // An answer that didn't finish is not shown as one.
    if (problem) {
      pending.remove();
      if (problem.unsent) mine.classList.add('unsent');
      note(problem.text, problem.final ? null : () => void ask(message, mine));
    }
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
  // The page arrives with its name in place; keep it unless the config says otherwise.
  const name = String(config.botName ?? '').trim();
  if (name) {
    document.title = name;
    $('title').textContent = name;
    $('avatar').textContent = [...name][0].toUpperCase();
  }
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
