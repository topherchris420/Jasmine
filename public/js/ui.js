/* Small DOM toolkit for the Studio: element builder, icons, dialogs, toasts and formatting. */

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'value' && 'value' in el) el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') el[key] = !!value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Replaces an element's children; like append(), it skips null/undefined/false and flattens arrays. */
export function fill(el, ...children) {
  return append(clear(el), children);
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/* ---------- icons (24px stroke icons) ---------- */

const ICONS = {
  flows: 'M6 3v6M6 15v6M3 9h6v6H3zM15 3h6v6h-6zM15 15h6v6h-6zM9 12h3m0 0V6h3m-3 6v6h3',
  context: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  models: 'M12 2l9 5v10l-9 5-9-5V7zM12 22V12m9-5l-9 5-9-5',
  integrations: 'M9 7V3m6 4V3M7 7h10v4a5 5 0 01-10 0zM12 16v5',
  prompts: 'M4 4h16v12H8l-4 4zM8 9h8M8 12h5',
  deploy: 'M12 3l4 4h-3v7h-2V7H8zM5 14v5h14v-5',
  playground: 'M8 6l-6 6 6 6M16 6l6 6-6 6M14 4l-4 16',
  logs: 'M4 5h16M4 10h16M4 15h10M4 20h7',
  reports: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
  docs: 'M6 3h9l5 5v13H6zM14 3v6h6M9 13h8M9 17h8',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  play: 'M7 4l13 8-13 8z',
  stop: 'M6 6h12v12H6z',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 3l10 18H2zM12 10v4M12 17v.5',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 11v6M12 7.5v.5',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  zoomIn: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5M8 11h6M11 8v6',
  zoomOut: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5M8 11h6',
  layout: 'M4 4h6v6H4zM14 14h6v6h-6zM7 10v4a3 3 0 003 3h4',
  upload: 'M12 16V4m0 0l-5 5m5-5l5 5M4 20h16',
  download: 'M12 4v12m0 0l-5-5m5 5l5-5M4 20h16',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  key: 'M14 10a4 4 0 11-1.2-2.8L21 15v4h-4v-2h-2v-2h-2l-.2-.2',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 018 0v4',
  globe: 'M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2c3 3 3 17 0 20M12 2c-3 3-3 17 0 20',
  chat: 'M4 5h16v11H9l-5 4z',
  api: 'M8 9l-3 3 3 3M16 9l3 3-3 3M13 7l-2 10',
  webhook: 'M9 7a3 3 0 115 2l-3 6m-2-3a3 3 0 102 5h6m-1-4a3 3 0 11-1 5',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  folder: 'M3 6h6l2 2h10v11H3z',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  json: 'M8 4c-2 0-2 2-2 4s-1 3-2 4c1 1 2 2 2 4s0 4 2 4M16 4c2 0 2 2 2 4s1 3 2 4c-1 1-2 2-2 4s0 4-2 4',
  rag: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v6c0 1.7 3.6 3 8 3M20 6v4M17 21a3 3 0 100-6 3 3 0 000 6zM21 22l-2-2',
  vector: 'M4 20L20 4M4 20h6M4 20v-6M14 4h6v6',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
  memory: 'M9 4h6v4h3v12H6V8h3zM9 12h6M9 16h4',
  chunk: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  file: 'M6 3h9l5 5v13H6zM14 3v6h6',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  variables: 'M5 4c-1 2-1 14 0 16M19 4c1 2 1 14 0 16M9 9l6 6M15 9l-6 6',
  http: 'M3 12h4l3-8 4 16 3-8h4',
  branch: 'M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9c0 6-12 3-12 9',
  loop: 'M17 2l4 4-4 4M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 01-3 3H3',
  batch: 'M4 6h10v10H4zM8 2h12v12',
  parallel: 'M6 3v18M12 3v18M18 3v18',
  flow: 'M5 12h14M13 6l6 6-6 6',
  agent: 'M12 3a4 4 0 014 4v1H8V7a4 4 0 014-4zM5 10h14v8a3 3 0 01-3 3H8a3 3 0 01-3-3zM9 14v1M15 14v1',
  classify: 'M3 5h18l-7 8v6l-4 2v-8z',
  image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9.5v.5',
  response: 'M9 15l-5-5 5-5M4 10h11a5 5 0 015 5v4',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 01-12 0zM12 18v4',
  table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
  bucket: 'M4 7h16l-2 13H6zM4 7c0-2 4-3 8-3s8 1 8 3',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  rss: 'M4 11a9 9 0 019 9M4 4a16 16 0 0116 16M5 20a1 1 0 100-2 1 1 0 000 2z',
  sms: 'M4 5h16v11H9l-5 4zM8 10h.5M12 10h.5M16 10h.5',
  app: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM16.5 13v7M13 16.5h7',
  stop2: 'M12 22a10 10 0 100-20 10 10 0 000 20zM9 9h6v6H9z',
  ask: 'M12 22a10 10 0 100-20 10 10 0 000 20zM9.5 9a2.5 2.5 0 114 2c-1 .7-1.5 1.3-1.5 2.5M12 17v.5',
  slack: 'M10 3a2 2 0 100 4h2V5a2 2 0 00-2-2zM3 14a2 2 0 104 0v-2H5a2 2 0 00-2 2zM14 21a2 2 0 100-4h-2v2a2 2 0 002 2zM21 10a2 2 0 10-4 0v2h2a2 2 0 002-2zM7 10h5v5',
  github: 'M9 19c-4 1.5-4-2-6-2.5M15 22v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 00-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V22',
  notion: 'M5 4h11l3 3v13H5zM9 8v8l6-8v8',
  teams: 'M4 7h10v10H4zM9 7v10M17 9a2 2 0 100-4 2 2 0 000 4zM16 11h4v5a2 2 0 01-4 0',
  discord: 'M7 7c3-1.5 7-1.5 10 0l2 9c-2 2-4 2.5-5 2.5l-1-2M7 7l-2 9c2 2 4 2.5 5 2.5l1-2M9 12h.5M14.5 12h.5',
  telegram: 'M21 4L3 11l6 2 2 6 3-4 5 4z',
  airtable: 'M12 3l9 4-9 4-9-4zM3 10v7l8 4v-7zM21 10v7l-8 4v-7',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 13A9 9 0 1111 3a7 7 0 0010 10z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  menu: 'M4 6h16M4 12h16M4 18h16',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  history: 'M3 12a9 9 0 103-6.7L3 8M3 3v5h5M12 7v5l3 2',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  dot: 'M12 13a1 1 0 100-2 1 1 0 000 2z',
  note: 'M5 4h14v11l-5 5H5zM14 20v-5h5',
};

export function icon(name, size = 16, extraClass = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon ${extraClass}`.trim());
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.app);
  svg.append(path);
  return svg;
}

export function button(label, opts = {}) {
  const { icon: ico, kind = 'secondary', onClick, title, disabled, size, type = 'button' } = opts;
  return h('button', { type, class: ['btn', `btn-${kind}`, size ? `btn-${size}` : '', !label ? 'btn-icon' : ''], title: title ?? (label ? undefined : opts.ariaLabel), 'aria-label': label ? undefined : (title ?? opts.ariaLabel), disabled, onClick },
    ico ? icon(ico, size === 'sm' ? 14 : 16) : null, label ? h('span', {}, label) : null);
}

/* ---------- feedback ---------- */

let toastHost;
export function toast(message, kind = 'info', ms = 4500) {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: `toast toast-${kind}` }, icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info'), h('span', {}, message));
  toastHost.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const dialog = h('dialog', { class: ['modal', wide ? 'modal-wide' : ''] });
  const close = () => {
    dialog.close();
    dialog.remove();
    onClose?.();
  };
  dialog.append(
    h('header', { class: 'modal-head' }, h('h2', {}, title), button('', { icon: 'close', kind: 'ghost', title: 'Close', onClick: close })),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('footer', { class: 'modal-foot' }, actions.map((a) => button(a.label, { kind: a.kind ?? 'secondary', icon: a.icon, disabled: a.disabled, onClick: () => a.onClick?.(close) }))) : null,
  );
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { close, el: dialog };
}

export function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, body: h('p', {}, message),
      onClose: () => { if (!done) resolve(false); },
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: (close) => { done = true; resolve(true); close(); } },
      ],
    });
    m.el.querySelector('.btn-primary, .btn-danger')?.focus();
  });
}

export function promptDialog(title, label, value = '', { placeholder = '', confirmLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value, placeholder });
    const submit = (close) => { done = true; resolve(input.value); close(); };
    const m = modal({
      title, body: h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input),
      onClose: () => { if (!done) resolve(null); },
      actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: confirmLabel, kind: 'primary', onClick: submit }],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(m.close); });
    input.focus();
    input.select();
  });
}

/* ---------- small components ---------- */

export function field(label, control, help, opts = {}) {
  return h('label', { class: ['field', opts.inline ? 'field-inline' : ''] },
    h('span', { class: 'field-label' }, label, opts.required ? h('span', { class: 'req' }, ' *') : null),
    control,
    help ? h('span', { class: 'field-help' }, help) : null);
}

export function input(value, onInput, attrs = {}) {
  return h('input', { class: 'input', value: value ?? '', ...attrs, onInput: (e) => onInput?.(e.target.value) });
}

const TAB_HINT_ID = 'jasmine-tab-hint';
/** Shared screen-reader description for code boxes that indent with Tab. */
function tabHint() {
  if (!document.getElementById(TAB_HINT_ID)) {
    document.body.append(h('span', { id: TAB_HINT_ID, class: 'sr-only' }, 'Tab inserts two spaces. Press Escape, then Tab, to move to the next control.'));
  }
  return TAB_HINT_ID;
}

export function textarea(value, onInput, attrs = {}) {
  const el = h('textarea', { class: ['input', attrs.mono ? 'mono' : ''], rows: attrs.rows ?? 4, placeholder: attrs.placeholder ?? '', spellcheck: attrs.mono ? 'false' : undefined, 'aria-label': attrs.ariaLabel, onInput: (e) => onInput?.(e.target.value) });
  el.value = value ?? '';
  if (attrs.mono) {
    // Tab indents inside code boxes; Escape releases the next Tab so keyboard users can leave the box.
    let released = false;
    el.addEventListener('focus', () => {
      released = false;
      el.setAttribute('aria-describedby', tabHint());
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        released = true;
        return;
      }
      if (e.key !== 'Tab') {
        if (e.key !== 'Shift') released = false;
        return;
      }
      if (e.shiftKey || released) {
        released = false;
        return; // default focus movement
      }
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end } = el;
      el.setRangeText('  ', s, end, 'end');
      el.dispatchEvent(new Event('input'));
    });
  }
  return el;
}

export function select(options, value, onChange, attrs = {}) {
  const el = h('select', { class: 'input', ...attrs, onChange: (e) => onChange?.(e.target.value) },
    options.map((o) => {
      const opt = typeof o === 'string' ? { value: o, label: o } : o;
      return h('option', { value: opt.value, selected: String(opt.value) === String(value ?? '') }, opt.label);
    }));
  return el;
}

export function toggle(checked, onChange, label) {
  return h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }), h('span', { class: 'toggle-track' }), label ? h('span', {}, label) : null);
}

export function badge(text, kind = 'neutral') {
  return h('span', { class: `badge badge-${kind}` }, text);
}

export function statusBadge(status) {
  const kind = { success: 'success', ready: 'success', ok: 'success', failed: 'danger', error: 'danger', cancelled: 'neutral', 'in-progress': 'info', processing: 'info', running: 'info', skipped: 'neutral' }[status] ?? 'neutral';
  return badge(status, kind);
}

export function spinner(size = 16) {
  return h('span', { class: 'spinner', style: { width: `${size}px`, height: `${size}px` }, role: 'progressbar', 'aria-label': 'Loading' });
}

export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon(iconName, 28)), h('h3', {}, title), text ? h('p', {}, text) : null, action ?? null);
}

export function copyButton(text, label = '') {
  return button(label, {
    icon: 'copy', kind: 'ghost', size: 'sm', title: 'Copy',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
        toast('Copied to clipboard', 'success', 1800);
      } catch {
        toast('Copy failed; select and copy manually', 'error');
      }
    },
  });
}

export function codeBlock(text, lang = '') {
  return h('div', { class: 'code-block' }, h('div', { class: 'code-head' }, h('span', {}, lang), copyButton(text)), h('pre', {}, h('code', {}, text)));
}

export function tabs(items, active, onChange) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map((t) => h('button', {
    type: 'button', role: 'tab', class: ['tab', t.id === active ? 'active' : ''], 'aria-selected': t.id === active ? 'true' : 'false',
    onClick: () => onChange(t.id),
  }, t.icon ? icon(t.icon, 14) : null, t.label, t.count !== undefined ? h('span', { class: 'tab-count' }, t.count) : null)));
}

/** Collapsible JSON tree. */
export function jsonView(value, depth = 0) {
  if (value === null || typeof value !== 'object') return h('span', { class: `jv-${value === null ? 'null' : typeof value}` }, typeof value === 'string' ? JSON.stringify(value) : String(value));
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  if (entries.length === 0) return h('span', { class: 'jv-punct' }, Array.isArray(value) ? '[]' : '{}');
  const open = depth < 2;
  const details = h('details', { class: 'jv', open });
  details.append(h('summary', {}, h('span', { class: 'jv-punct' }, Array.isArray(value) ? `[ ${entries.length} ]` : `{ ${entries.length} }`)));
  const list = h('div', { class: 'jv-body' });
  for (const [k, v] of entries.slice(0, 500)) list.append(h('div', { class: 'jv-row' }, h('span', { class: 'jv-key' }, Array.isArray(value) ? `${k}` : JSON.stringify(k)), h('span', { class: 'jv-punct' }, ': '), jsonView(v, depth + 1)));
  if (entries.length > 500) list.append(h('div', { class: 'muted' }, `… ${entries.length - 500} more`));
  details.append(list);
  return details;
}

export function jsonPanel(value, title) {
  return h('div', { class: 'json-panel' }, h('div', { class: 'json-panel-head' }, h('span', {}, title ?? ''), copyButton(() => JSON.stringify(value, null, 2))), h('div', { class: 'json-panel-body' }, jsonView(value)));
}

/* ---------- formatting ---------- */

export const pretty = (v) => JSON.stringify(v, null, 2);

export function timeAgo(iso) {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function dateTime(iso) {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : '—';
}

export function ms(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 1) return '<1 ms';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

export const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString());
export const bytes = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

export function debounce(fn, wait) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  wrapped.flush = () => {
    clearTimeout(t);
    fn();
  };
  return wrapped;
}

export function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export function downloadFile(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Page scaffold: title row with actions, then content. */
export function page(title, subtitle, actions, ...content) {
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), subtitle ? h('p', { class: 'page-sub' }, subtitle) : null), h('div', { class: 'page-actions' }, actions ?? [])),
    ...content);
}

export function card(...children) {
  return h('section', { class: 'card' }, ...children);
}

export function table(columns, rows, { onRowClick, empty } = {}) {
  if (!rows.length && empty) return empty;
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.class, style: c.width ? { width: c.width } : undefined }, c.label)))),
    h('tbody', {}, rows.map((row) => h('tr', {
      class: onRowClick ? 'clickable' : '',
      // Clickable rows are keyboard-reachable: Tab focuses them, Enter or Space opens them.
      tabindex: onRowClick ? '0' : undefined,
      onClick: onRowClick ? (e) => { if (!e.target.closest('button, a, input, select, textarea')) onRowClick(row); } : undefined,
      onKeydown: onRowClick ? (e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        onRowClick(row);
      } : undefined,
    },
      columns.map((c) => h('td', { class: c.class }, c.render ? c.render(row) : row[c.key])))))));
}
