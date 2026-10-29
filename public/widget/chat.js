/*
 * Jasmine chat widget. Embed with:
 *   <script src="https://your-jasmine-host/widget/chat.js" data-flow-id="my-flow" defer></script>
 * Optional attributes: data-position="left", data-open="true", data-color="#0b5d63".
 */
(() => {
  const script = document.currentScript;
  if (!script) return;
  const flowId = script.dataset.flowId;
  if (!flowId) return console.error('[jasmine] data-flow-id is required on the widget script tag');
  const base = new URL(script.src, location.href).origin;
  const left = script.dataset.position === 'left';
  const id = `jasmine-chat-${flowId.replace(/[^\w-]/g, '')}`;
  if (document.getElementById(id)) return;

  const host = document.createElement('div');
  host.id = id;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .launcher { position: fixed; bottom: 20px; ${left ? 'left' : 'right'}: 20px; width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;
      background: var(--brand, #0b5d63); color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.22); display: grid; place-items: center; z-index: 2147483646; transition: transform .15s; }
    .launcher:hover { transform: scale(1.05); }
    .launcher:focus-visible { outline: 3px solid rgba(11,93,99,.45); outline-offset: 2px; }
    .panel { position: fixed; bottom: 88px; ${left ? 'left' : 'right'}: 20px; width: min(400px, calc(100vw - 32px)); height: min(640px, calc(100vh - 120px));
      border: none; border-radius: 16px; box-shadow: 0 12px 48px rgba(0,0,0,.25); z-index: 2147483647; background: #fff; display: none; }
    .panel.open { display: block; }
    @media (max-width: 480px) { .panel { inset: 0; width: 100vw; height: 100vh; border-radius: 0; bottom: 0; } }
  `;
  const button = document.createElement('button');
  button.className = 'launcher';
  button.type = 'button';
  button.setAttribute('aria-label', 'Open chat');
  button.setAttribute('aria-expanded', 'false');
  const chatIcon = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>';
  const closeIcon = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  button.innerHTML = chatIcon;
  let frame = null;
  const setOpen = (open) => {
    if (open && !frame) {
      frame = document.createElement('iframe');
      frame.className = 'panel';
      frame.title = 'Chat';
      frame.src = `${base}/apps/chat/${encodeURIComponent(flowId)}?embed=1`;
      frame.allow = 'clipboard-write';
      shadow.append(frame);
    }
    frame?.classList.toggle('open', open);
    button.innerHTML = open ? closeIcon : chatIcon;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
  };
  button.addEventListener('click', () => setOpen(!frame?.classList.contains('open')));
  window.addEventListener('message', (e) => {
    if (e.origin === base && e.data?.type === 'jasmine:close' && e.data.flowId === flowId) setOpen(false);
  });
  shadow.append(style, button);
  document.body.append(host);

  const color = script.dataset.color;
  const apply = (c) => { if (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c)) host.style.setProperty('--brand', c); };
  if (color) apply(color);
  else fetch(`${base}/api/chat/${encodeURIComponent(flowId)}/config`).then((r) => (r.ok ? r.json() : null)).then((c) => apply(c?.colors?.primary)).catch(() => {});
  if (script.dataset.open === 'true') setOpen(true);
})();
