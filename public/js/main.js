import { api, ApiError, onAuthRequired, setKey } from './api.js';
import { button, fill, h, icon, modal, toast } from './ui.js';

const NAV = [
  { path: '/', label: 'Overview', icon: 'reports' },
  { section: 'Build' },
  { path: '/templates', label: 'Templates', icon: 'sparkles' },
  { path: '/flows', label: 'Flows', icon: 'flows' },
  { path: '/context', label: 'Context', icon: 'context' },
  { path: '/models', label: 'Models', icon: 'models' },
  { path: '/integrations', label: 'Integrations', icon: 'integrations' },
  { path: '/prompts', label: 'Prompts', icon: 'prompts' },
  { section: 'Deploy' },
  { path: '/deployments', label: 'Deployments', icon: 'deploy' },
  { path: '/playground', label: 'API Playground', icon: 'playground' },
  { section: 'Monitor' },
  { path: '/logs', label: 'Logs', icon: 'logs' },
  { path: '/reports', label: 'Reports', icon: 'reports' },
  { path: '/alerts', label: 'Alerts', icon: 'logs' },
];

const ROUTES = [
  { pattern: /^\/studio(\/.*)?$/, redirect: '/flows' },
  { pattern: /^\/$/, load: () => import('./pages/overview.js') },
  { pattern: /^\/setup$/, load: () => import('./pages/setup.js') },
  { pattern: /^\/templates$/, load: () => import('./pages/templates.js') },
  { pattern: /^\/hosting$/, load: () => import('./pages/hosting.js') },
  { pattern: /^\/flows$/, load: () => import('./pages/flows.js') },
  { pattern: /^\/flows\/([^/]+)$/, load: () => import('./pages/builder.js'), keys: ['id'], fullBleed: true },
  { pattern: /^\/context$/, load: () => import('./pages/context.js') },
  { pattern: /^\/context\/([^/]+)$/, load: () => import('./pages/collection.js'), keys: ['name'] },
  { pattern: /^\/models$/, load: () => import('./pages/models.js') },
  { pattern: /^\/integrations$/, load: () => import('./pages/integrations.js') },
  { pattern: /^\/prompts$/, load: () => import('./pages/prompts.js') },
  { pattern: /^\/deployments$/, load: () => import('./pages/deployments.js') },
  { pattern: /^\/deployments\/([^/]+)$/, load: () => import('./pages/deployment.js'), keys: ['id'] },
  { pattern: /^\/playground$/, load: () => import('./pages/playground.js') },
  { pattern: /^\/logs$/, load: () => import('./pages/logs.js') },
  { pattern: /^\/logs\/([^/]+)$/, load: () => import('./pages/run.js'), keys: ['id'] },
  { pattern: /^\/reports$/, load: () => import('./pages/reports.js') },
  { pattern: /^\/alerts$/, load: () => import('./pages/alerts.js') },
  { pattern: /^\/settings$/, load: () => import('./pages/settings.js') },
  { pattern: /^\/docs$/, load: () => import('./pages/docs.js') },
];

const root = document.getElementById('app');
let cleanup = null;
let renderToken = 0;

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  render();
}

/* ---------- theme ---------- */

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
function storedTheme() {
  try {
    return localStorage.getItem('jasmine.theme');
  } catch {
    return null;
  }
}
applyTheme(storedTheme());

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem('jasmine.theme', next);
  } catch {
    /* ignore */
  }
}

/* ---------- auth ---------- */

let authPrompt = null;
onAuthRequired(() => {
  authPrompt ??= new Promise((resolve, reject) => {
    const input = h('input', { class: 'input mono', type: 'password', placeholder: 'jsm_a_…', autocomplete: 'off' });
    let done = false;
    const submit = async (close) => {
      if (!input.value.trim()) return;
      try {
        await api.post('/api/auth/session', { apiKey: input.value.trim() });
        input.value = '';
        setKey('');
        done = true;
        close();
        resolve();
      } catch (error) { toast(error.message, 'error'); }
    };
    const m = modal({
      title: 'Sign in to your workspace',
      body: h('div', {}, h('p', {}, 'Enter your workspace access key. Ask the workspace owner for an admin key if you do not have one.'), input),
      actions: [{ label: 'Cancel', onClick: (close) => close() }, { label: 'Sign in', kind: 'primary', icon: 'lock', onClick: submit }],
      onClose: () => {
        if (!done) reject(new ApiError('Access Denied', 403, null));
      },
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(m.close); });
    input.focus();
  }).finally(() => {
    authPrompt = null;
  });
  return authPrompt;
});

/* ---------- shell ---------- */

let authRequired = false;
const shell = {
  sidebar: h('aside', { class: 'sidebar', 'aria-label': 'Main navigation' }),
  main: h('main', { class: 'main', id: 'main' }),
  project: { name: 'Jasmine' },
};

function renderSidebar() {
  const current = location.pathname;
  fill(shell.sidebar, 
    h('a', { class: 'brand', href: '/', 'data-link': '' }, h('span', { class: 'brand-mark' }, icon('sparkles', 18)), h('span', { class: 'brand-name' }, 'Jasmine'), h('span', { class: 'brand-tag' }, 'studio')),
    h('div', { class: 'project-chip', title: 'Project' }, icon('folder', 14), h('span', {}, shell.project.name)),
    button('Search workspace', { kind: 'ghost', icon: 'search', onClick: commandPalette }),
    h('nav', { class: 'nav' }, NAV.map((item) => item.section
      ? h('div', { class: 'nav-section' }, item.section)
      : h('a', { href: item.path, 'data-link': '', class: ['nav-item', current === item.path || (item.path !== '/' && current.startsWith(`${item.path}/`)) ? 'active' : ''], 'aria-current': (current === item.path || (item.path !== '/' && current.startsWith(`${item.path}/`))) ? 'page' : undefined }, icon(item.icon, 16), h('span', {}, item.label)))),
    h('div', { class: 'sidebar-foot' },
      h('a', { href: '/hosting', 'data-link': '', class: ['nav-item', current === '/hosting' ? 'active' : ''] }, icon('deploy', 16), h('span', {}, 'Hosting')),
      h('a', { href: '/setup', 'data-link': '', class: ['nav-item', current === '/setup' ? 'active' : ''] }, icon('check', 16), h('span', {}, 'Getting started')),
      h('a', { href: '/docs', 'data-link': '', class: ['nav-item', current === '/docs' ? 'active' : ''] }, icon('docs', 16), h('span', {}, 'API docs')),
      h('a', { href: '/settings', 'data-link': '', class: ['nav-item', current === '/settings' ? 'active' : ''] }, icon('settings', 16), h('span', {}, 'Settings')),
      h('div', { class: 'sidebar-tools' },
        button('', { icon: 'moon', kind: 'ghost', title: 'Toggle dark mode', onClick: toggleTheme }),
        authRequired ? button('Sign out', { icon: 'logout', kind: 'ghost', onClick: async () => { await api.del('/api/auth/session'); setKey(''); location.reload(); } }) : null)),
  );
}

async function render() {
  const token = ++renderToken;
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
    cleanup = null;
  }
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const route = ROUTES.find((r) => r.pattern.test(path));
  if (route?.redirect) {
    history.replaceState(null, '', route.redirect);
    return render();
  }
  document.body.classList.toggle('full-bleed', !!route?.fullBleed);
  document.body.classList.remove('nav-open');
  renderSidebar();
  fill(shell.main, h('div', { class: 'page-loading' }, h('span', { class: 'spinner' })));
  if (!route) {
    fill(shell.main, h('div', { class: 'page' }, h('h1', {}, 'Not found'), h('p', {}, 'That page does not exist. '), h('a', { href: '/flows', 'data-link': '' }, 'Go to flows')));
    return;
  }
  const match = route.pattern.exec(path);
  const params = Object.fromEntries((route.keys ?? []).map((k, i) => [k, decodeURIComponent(match[i + 1])]));
  try {
    const mod = await route.load();
    if (token !== renderToken) return;
    const container = h('div', { class: 'view' });
    fill(shell.main, container);
    const result = await mod.render(container, params, { navigate, query: new URLSearchParams(location.search) });
    if (token !== renderToken) {
      if (typeof result === 'function') result();
      return;
    }
    cleanup = typeof result === 'function' ? result : null;
    const title = container.querySelector('h1')?.textContent ?? container.querySelector('[data-page-title]')?.dataset.pageTitle;
    document.title = title ? `${title} · Jasmine` : 'Jasmine';
  } catch (e) {
    if (token !== renderToken) return;
    console.error(e);
    fill(shell.main, h('div', { class: 'page' }, h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, e.status === 403 ? 'Access denied' : 'Something went wrong'), h('p', {}, e.message)))));
  }
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', render);

const mobileBar = h('header', { class: 'mobile-bar' },
  button('', { icon: 'menu', kind: 'ghost', title: 'Menu', onClick: () => document.body.classList.toggle('nav-open') }),
  h('span', {}, 'Jasmine'));
async function start() {
  fill(root, h('div', { class: 'page-loading' }, h('span', { class: 'spinner' })));
  try {
    const status = await api.get('/api/status');
    authRequired = status.authRequired;
    shell.project.name = status.project?.name ?? 'Jasmine';
    // Exchange older browser-stored keys once, then remove them permanently.
    let oldKey = '';
    try { oldKey = localStorage.getItem('jasmine.adminKey') ?? ''; localStorage.removeItem('jasmine.adminKey'); } catch { /* optional */ }
    if (oldKey) await api.post('/api/auth/session', { apiKey: oldKey }).catch(() => {});
    const session = await api.get('/api/auth/session');
    if (authRequired && !session.authenticated) return signIn();
    const setup = await api.get('/api/setup');
    if (!setup.complete && location.pathname === '/') history.replaceState(null, '', '/setup');
    fill(root, mobileBar, shell.sidebar, shell.main);
    render();
  } catch (error) {
    fill(root, h('main', { class: 'entry-screen', id: 'main' }, h('section', { class: 'entry-card' },
      h('span', { class: 'brand-mark' }, icon('sparkles', 24)), h('h1', {}, 'Your workspace is waiting'),
      h('p', {}, error.message),
      h('p', { class: 'muted' }, 'If you own this workspace, check its runtime connection and hosting settings.'),
      button('Try again', { kind: 'primary', icon: 'refresh', onClick: start }),
      h('a', { href: 'https://github.com/topherchris420/Jasmine/blob/master/docs/VERCEL.md', target: '_blank', rel: 'noopener' }, 'Deployment guide ↗'))));
  }
}

function signIn() {
  const key = h('input', { class: 'input', type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Workspace access key', id: 'workspace-key' });
  const message = h('p', { role: 'alert', class: 'login-error' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Open workspace →');
  const form = h('form', { class: 'stack', onSubmit: async event => {
    event.preventDefault(); submit.disabled = true; message.textContent = '';
    try { await api.post('/api/auth/session', { apiKey: key.value.trim() }); key.value = ''; await start(); }
    catch (error) { message.textContent = error.message; }
    finally { submit.disabled = false; }
  } }, h('label', { for: 'workspace-key', class: 'field-label' }, 'Access key'), key, message, submit);
  fill(root, h('main', { class: 'entry-screen', id: 'main' },
    h('section', { class: 'entry-story' }, h('span', { class: 'eyebrow' }, 'VERS3DYNAMICS / JASMINE'),
      h('h1', {}, 'An idea is only', h('br'), 'the beginning.'),
      h('p', {}, 'Build the workflow. Connect your intelligence. Put it to work.'),
      h('div', { class: 'entry-steps' }, ['01  Build visually', '02  Test every step', '03  Ship your application'].map(text => h('p', {}, text)))),
    h('section', { class: 'entry-card' }, h('span', { class: 'brand-mark' }, icon('sparkles', 24)),
      h('h2', {}, 'Welcome to Jasmine'), h('p', { class: 'muted' }, 'Sign in to your workspace to start building.'), form,
      h('p', { class: 'small muted' }, 'Your workspace owner provides your access key. This browser receives a secure session; your key is not saved in browser storage.'))));
  key.focus();
}

async function commandPalette() {
  if (!root.contains(shell.sidebar)) return;
  let close = () => {};
  const results = h('div', { class: 'command-results', role: 'list', 'aria-live': 'polite' });
  const entries = NAV.filter(x => x.path).concat([{ path: '/setup', label: 'Getting started' }, { path: '/hosting', label: 'Hosting' }, { path: '/settings', label: 'Settings' }]);
  const draw = query => {
    const matches = entries.filter(item => item.label.toLowerCase().includes(query.toLowerCase()));
    fill(results, matches.length ? matches.slice(0, 18).map(item => button(item.label, { kind: 'ghost', onClick: () => { close(); navigate(item.path); } })) : h('p', { class: 'muted' }, 'No matching pages or flows.'));
  };
  const search = h('input', { class: 'input', placeholder: 'Search pages and flows…', 'aria-label': 'Search workspace', onInput: e => draw(e.target.value), onKeydown: e => { if (e.key === 'Enter') results.querySelector('button')?.click(); } });
  const dialog = modal({ title: 'Go anywhere', body: h('div', { class: 'stack' }, search, results) });
  close = dialog.close; draw(''); search.focus();
  try { for (const flow of await api.get('/api/flows')) entries.push({ path: `/flows/${flow.id}`, label: `Flow · ${flow.name}` }); draw(search.value); } catch { /* page links still work */ }
}
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); void commandPalette(); } });
void start();

export function setProjectName(name) {
  shell.project.name = name;
  renderSidebar();
}
