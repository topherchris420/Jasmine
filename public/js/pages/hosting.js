import { api } from '../api.js';
import { badge, button, card, h, icon, page } from '../ui.js';

export async function render(container) {
  const report = await api.get('/api/hosting');
  container.append(page('Your workspace, online.', 'Vercel serves Studio. A persistent runtime keeps your flows, documents, jobs and history.', [],
    h('div', { class: 'hosting-topology' }, h('div', {}, h('strong', {}, 'Your browser'), h('p', {}, 'Session protected Studio')), icon('chevronRight'), h('div', {}, h('strong', {}, 'Vercel'), h('p', {}, 'Frontend + API gateway')), icon('chevronRight'), h('div', {}, h('strong', {}, 'Jasmine runtime'), h('p', {}, 'Engine + persistent volume'))),
    card(h('div', { class: 'card-head' }, h('h2', {}, 'Configuration checks'), badge(report.mode === 'vercel-gateway' ? 'Gateway enabled' : 'Direct runtime', 'accent')),
      h('p', { class: 'muted small' }, 'These checks inspect runtime configuration. They do not verify the host’s volume mount, Vercel connection or model availability.'),
      h('div', { class: 'checklist' }, report.checks.map(check => h('div', { class: 'check-item' },
        icon(check.state === 'ready' ? 'check' : 'alert', 18), h('div', { class: 'grow' }, h('strong', {}, check.label), h('p', { class: 'small muted' }, check.detail)),
        badge(check.state === 'ready' ? 'Configured' : check.state === 'blocking' ? 'Needs attention' : 'Review', check.state === 'ready' ? 'success' : 'warning'))))),
    h('div', { class: 'grid grid-2' }, card(h('h2', {}, 'Publish on Vercel'), h('p', {}, 'Import the GitHub repository, then connect it to your runtime with JASMINE_RUNTIME_URL and the matching gateway secret.'),
      h('a', { href: 'https://github.com/topherchris420/Jasmine/blob/master/docs/VERCEL.md', class: 'btn btn-primary', target: '_blank', rel: 'noopener' }, 'Open deployment guide ↗')),
      card(h('h2', {}, 'Operating this release'), h('p', {}, 'One trusted workspace per runtime. Admins can configure integrations, files and code, so give workspace access only to people you trust.'),
        h('p', {}, report.mode === 'vercel-gateway' ? 'Vercel uploads are limited to 4 MiB. Live streams reconnect for longer runs; jobs continue on the runtime.' : 'Jobs and schedules run while the persistent runtime is online.'),
        h('a', { href: '/settings', 'data-link': '' }, 'Manage keys and encrypted backups →')))));
}
