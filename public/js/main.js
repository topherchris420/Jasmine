import { ApiError, getKey, onAuthRequired, setKey, status } from './api.js';
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
  sidebar: h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Main navigation' }),
  main: h('main', { class: 'main', id: 'main' }),
  project: { name: 'Jasmine' },
};

/* The label text is hidden in the builder's collapsed rail, so each link also carries an accessible name and tooltip. */
function navLink(path, label, iconName, active) {
  return h('a', { href: path, 'data-link': '', class: ['nav-item', active ? 'active' : ''], 'aria-label': label, title: label, 'aria-current': active ? 'page' : undefined }, icon(iconName, 16), h('span', {}, label));
}

function renderSidebar() {
  const current = location.pathname;
  fill(shell.sidebar, 
    h('a', { class: 'brand', href: '/', 'data-link': '', 'aria-label': 'Jasmine home', title: 'Home' }, h('span', { class: 'brand-mark' }, icon('sparkles', 18)), h('span', { class: 'brand-name' }, 'Jasmine'), h('span', { class: 'brand-tag' }, 'local')),
    h('div', { class: 'project-chip', title: 'Project' }, icon('folder', 14), h('span', {}, shell.project.name)),
    h('nav', { class: 'nav' }, NAV.map((item) => item.section
      ? h('div', { class: 'nav-section' }, item.section)
      : navLink(item.path, item.label, item.icon, current === item.path || current.startsWith(`${item.path}/`)))),
    h('div', { class: 'sidebar-foot' },
      navLink('/docs', 'API docs', 'docs', current === '/docs'),
      navLink('/settings', 'Settings', 'settings', current === '/settings'),
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
  setNav(false);
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
  setNav(false); // also when the link is the current page, which navigate() leaves alone
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', render);

/* ---------- mobile navigation drawer ---------- */

const menuButton = button('', { icon: 'menu', kind: 'ghost', title: 'Menu', onClick: () => setNav(!document.body.classList.contains('nav-open')) });
menuButton.setAttribute('aria-controls', 'sidebar');
menuButton.setAttribute('aria-expanded', 'false');
const backdrop = h('div', { class: 'nav-backdrop', 'aria-hidden': 'true', onClick: () => setNav(false, true) });

function setNav(open, restoreFocus = false) {
  const wasOpen = document.body.classList.contains('nav-open');
  document.body.classList.toggle('nav-open', open);
  menuButton.setAttribute('aria-expanded', String(open));
  if (open && !wasOpen) shell.sidebar.querySelector('a.nav-item')?.focus();
  if (!open && wasOpen && restoreFocus) menuButton.focus();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('nav-open') && !document.querySelector('dialog[open]')) setNav(false, true);
});

const mobileBar = h('header', { class: 'mobile-bar' }, menuButton, h('span', {}, 'Jasmine'));
root.append(mobileBar, backdrop, shell.sidebar, shell.main);
status().then((s) => {
  if (!s) return;
  shell.project.name = s.project?.name ?? 'Jasmine';
  renderSidebar();
});
render();

export function setProjectName(name) {
  shell.project.name = name;
  renderSidebar();
}
