import { api, ApiError, getKey, onAuthRequired, setKey } from './api.js';
import { button, fill, h, icon, modal, toast } from './ui.js';

const NAV = [
  { section: 'Build' },
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
    const submit = (close) => {
      if (!input.value.trim()) return;
      setKey(input.value.trim());
      done = true;
      close();
      resolve();
    };
    const m = modal({
      title: 'Admin key required',
      body: h('div', {}, h('p', {}, 'This project requires an admin API key. Create one under Settings → API keys, or use the JASMINE_API_KEY the server was started with.'), input),
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

const shell = {
  sidebar: h('aside', { class: 'sidebar', 'aria-label': 'Main navigation' }),
  main: h('main', { class: 'main', id: 'main' }),
  project: { name: 'Jasmine' },
};

function renderSidebar() {
  const current = location.pathname;
  fill(shell.sidebar, 
    h('a', { class: 'brand', href: '/', 'data-link': '' }, h('span', { class: 'brand-mark' }, icon('sparkles', 18)), h('span', { class: 'brand-name' }, 'Jasmine'), h('span', { class: 'brand-tag' }, 'local')),
    h('div', { class: 'project-chip', title: 'Project' }, icon('folder', 14), h('span', {}, shell.project.name)),
    h('nav', { class: 'nav' }, NAV.map((item) => item.section
      ? h('div', { class: 'nav-section' }, item.section)
      : h('a', { href: item.path, 'data-link': '', class: ['nav-item', current === item.path || current.startsWith(`${item.path}/`) ? 'active' : ''], 'aria-current': current.startsWith(item.path) ? 'page' : undefined }, icon(item.icon, 16), h('span', {}, item.label)))),
    h('div', { class: 'sidebar-foot' },
      h('a', { href: '/docs', 'data-link': '', class: ['nav-item', current === '/docs' ? 'active' : ''] }, icon('docs', 16), h('span', {}, 'API docs')),
      h('a', { href: '/settings', 'data-link': '', class: ['nav-item', current === '/settings' ? 'active' : ''] }, icon('settings', 16), h('span', {}, 'Settings')),
      h('div', { class: 'sidebar-tools' },
        button('', { icon: 'moon', kind: 'ghost', title: 'Toggle dark mode', onClick: toggleTheme }),
        getKey() ? button('', { icon: 'logout', kind: 'ghost', title: 'Forget admin key', onClick: () => { setKey(''); toast('Signed out of this browser', 'info'); render(); } }) : null)),
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
root.append(mobileBar, shell.sidebar, shell.main);
api.get('/api/status').then((s) => {
  shell.project.name = s.project?.name ?? 'Jasmine';
  renderSidebar();
}).catch(() => {});
render();

export function setProjectName(name) {
  shell.project.name = name;
  renderSidebar();
}
