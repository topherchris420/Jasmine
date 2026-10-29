// The page a visitor sees instead of a hosted chat or search page that cannot be shown: the runtime is offline, or
// the link leads nowhere. Everything is inline under a per-response nonce and nothing else is requested, so it renders
// when nothing else can be reached, and it can stand in for an embedded widget.

const STATES = {
  offline: { status: 503, eyebrow: 'Offline for now', heading: noun => `This ${noun} is resting.`, lede: 'It runs on its owner’s own machine, and that machine isn’t reachable right now.' },
  timeout: { status: 504, eyebrow: 'No answer yet', heading: noun => `This ${noun} didn’t answer in time.`, lede: 'It runs on its owner’s own machine, which didn’t respond in time just now.' },
  unconfigured: { status: 503, eyebrow: 'Not connected yet', heading: noun => `This ${noun} isn’t connected yet.`, lede: 'It runs on its owner’s own machine, and this site hasn’t been connected to it.' },
  missing: { status: 404, eyebrow: 'Page not found', heading: (noun, app) => `This ${app} isn’t available.`, lede: 'The link may be mistyped, or its owner hasn’t published it yet or has turned it off. If someone shared it with you, ask them for a current link.' },
};

// Jasmine, drawn: five pinwheel petals, closed into a bud while the machine is away. It opens when the machine answers.
const PETAL = 'M50 50C41 43 37 23 50 8C60 20 62 40 50 50Z';
const MARK = `<svg class="mark" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${
  [0, 72, 144, 216, 288].map(a => `<g transform="rotate(${a} 50 50)"><path class="petal" d="${PETAL}"/></g>`).join('')
}<circle class="heart" cx="50" cy="50" r="4.5"/></svg>`;

const STYLE = `
:root{--bg:#fafbfc;--text:#18282e;--text-2:#43565f;--text-3:#5c7079;--accent:#0b5d63;--accent-text:#fff;--petal:#fff;--ease:cubic-bezier(.2,.7,.2,1);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111719;--text:#e7eeeb;--text-2:#b4c1bd;--text-3:#92a09b;--accent:#6fcfc7;--accent-text:#052523;--petal:#f2efe6;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0}
body{display:flex;flex-direction:column;min-height:100vh;min-height:100dvh;background:var(--bg);color:var(--text);font:16px/1.6 "IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{flex:1;display:flex;flex-direction:column;justify-content:center;width:100%;max-width:35rem;margin:0 auto;padding:56px 24px 24px}
.mark{width:76px;height:76px;margin:0 0 30px -4px;overflow:visible}
.petal{fill:var(--petal);stroke:var(--accent);stroke-width:1.6;stroke-linejoin:round;transform-box:view-box;transform-origin:50px 50px;transition:transform .9s var(--ease),fill .9s var(--ease)}
.heart{fill:var(--accent)}
[data-heal] .petal{fill:color-mix(in srgb,var(--accent) 12%,var(--petal));transform:rotate(-46deg) scale(.62)}
[data-heal] .mark{animation:breathe 4s ease-in-out infinite}
[data-heal].bloom .petal{fill:var(--petal);transform:none}
[data-heal].bloom .mark{animation:none}
[data-state=missing] .petal{fill:none;stroke:var(--text-3)}
[data-state=missing] .heart{fill:var(--text-3)}
@keyframes breathe{50%{transform:scale(1.07);opacity:.8}}
.eyebrow{margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
h1{margin:0 0 14px;font-size:clamp(26px,6.4vw,34px);line-height:1.2;font-weight:600;letter-spacing:-.025em;text-wrap:balance}
p{margin:0 0 12px;color:var(--text-2)}
.owner{margin-top:10px;font-size:14px;color:var(--text-3)}
.actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px 18px;margin-top:22px}
.button{display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:8px;background:var(--accent);color:var(--accent-text);font-weight:600;text-decoration:none}
.button:hover{filter:brightness(1.1)}
.next{font-size:14px;color:var(--text-3);font-variant-numeric:tabular-nums}
.status{min-height:1.6em;margin:14px 0 0;font-size:14px;color:var(--text-3)}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
footer{padding:20px 24px 28px;text-align:center;font-size:12px;color:var(--text-3)}
.close{position:fixed;top:10px;right:10px;display:grid;place-items:center;width:40px;height:40px;border:0;border-radius:8px;background:transparent;color:var(--text-2);cursor:pointer}
.close:hover{color:var(--text);background:color-mix(in srgb,var(--text) 8%,transparent)}
.close[hidden]{display:none}
.framed main{max-width:none;padding:28px 20px 12px}
.framed .mark{width:52px;height:52px;margin-bottom:18px}
.framed h1{font-size:22px}
.framed footer{padding:12px 20px 16px}
@media (prefers-reduced-motion:reduce){.mark,.petal{animation:none!important;transition:none!important}}
`;

const SCRIPT = `(() => {
  const root = document.documentElement;
  const flowId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const framed = window.parent !== window;
  root.classList.toggle('framed', framed);
  // Inside the chat widget this page covers a phone screen, so it needs its own way out.
  if (new URLSearchParams(location.search).get('embed') === '1') {
    const close = document.getElementById('close');
    close.hidden = false;
    close.addEventListener('click', () => parent.postMessage({ type: 'jasmine:close', flowId }, '*'));
  }
  // An embedded search box grows to fit what it shows.
  if (framed && root.dataset.app === 'search') {
    new ResizeObserver(() => parent.postMessage({ type: 'jasmine:height', flowId, height: root.scrollHeight }, '*')).observe(document.body);
  }
  if (!('heal' in root.dataset)) return;
  // Check again, further apart each time (about half an hour in all), and open the real page once the machine answers.
  const DELAYS = [10, 20, 40, 80, 160, 300, 300, 300, 300, 300];
  const next = document.getElementById('next');
  const status = document.getElementById('status');
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let attempt = 0, due = 0, timer = 0, busy = false;
  const clock = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  function wait() {
    clearTimeout(timer);
    if (busy || !due || document.hidden) return;
    const left = Math.ceil((due - Date.now()) / 1000);
    if (left <= 0) return void check();
    next.textContent = 'Checking again in ' + clock(left);
    timer = setTimeout(wait, 1000);
  }
  function schedule() {
    if (attempt >= DELAYS.length) {
      due = 0;
      next.textContent = '';
      status.textContent = 'Still away. Try again whenever you like.';
      return;
    }
    due = Date.now() + DELAYS[attempt++] * 1000;
    wait();
  }
  async function check() {
    if (busy) return;
    busy = true;
    clearTimeout(timer);
    next.textContent = 'Checking…';
    let back = false;
    try {
      const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store', headers: { accept: 'text/html' }, signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined });
      back = res.status < 500;
    } catch { /* still away */ }
    busy = false;
    if (!back) return schedule();
    next.textContent = '';
    status.textContent = 'It’s back. Opening the ' + root.dataset.app + '…';
    root.classList.add('bloom');
    setTimeout(() => location.reload(), calm ? 0 : 900);
  }
  document.getElementById('again').addEventListener('click', event => { event.preventDefault(); attempt = 0; void check(); });
  document.addEventListener('visibilitychange', wait);
  addEventListener('online', () => { attempt = 0; void check(); });
  schedule();
})();`;

const CLOSE = '<button type="button" class="close" id="close" aria-label="Close" hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';

/**
 * A self-contained HTML page for a hosted chat or search page that cannot be shown. `state` is offline, timeout or
 * unconfigured (the runtime cannot answer, so the page checks again by itself), or missing (no such page).
 */
export function noticePage({ app, state }) {
  const kind = app === 'search' ? 'search' : 'chat';
  const words = STATES[state];
  const heal = state !== 'missing';
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const body = `<!doctype html>
<html lang="en" data-app="${kind}" data-state="${state}"${heal ? ' data-heal' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${words.eyebrow} · Jasmine</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
${MARK}
<p class="eyebrow">${words.eyebrow}</p>
<h1>${words.heading(kind === 'search' ? 'search' : 'assistant', kind)}</h1>
<p>${words.lede}</p>
${heal ? `<p>This page checks again by itself and opens the ${kind} as soon as it answers.</p>
<div class="actions"><a class="button" id="again" href="">Try again</a><span class="next" id="next"></span></div>
<p class="status" id="status" role="status"></p>` : `<p class="owner">Own this workspace? In Jasmine Studio, deploy this workflow with a ${kind === 'search' ? 'Search' : 'Chat or Ask'} widget trigger, then reload.</p>`}
</main>
<footer>Powered by Jasmine</footer>
${CLOSE}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
  return {
    status: words.status,
    body,
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      // It stands in for pages that live inside other sites' widgets, and it holds nothing worth framing.
      'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors *`,
      ...(heal ? { 'retry-after': '30' } : {}),
    },
  };
}
